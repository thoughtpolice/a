// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Analyze a Git packfile from disk without buffering all objects in memory.
//!
//! Streams through the pack one object at a time, collecting type/size/delta
//! statistics and printing memory projections for the current vs. potential
//! streaming parse strategies.
//!
//! Usage: packstat <path-to-.pack-file>

use std::collections::HashMap;
use std::path::PathBuf;

use clap::Parser;
use tokio::io::BufReader;

use fetch_git::objects::GitObjectType;
use fetch_git::packfile::{self, PackfileStream};

#[derive(Parser)]
#[command(
    name = "packstat",
    about = "Analyze a Git packfile's structure and estimate memory usage"
)]
struct Args {
    /// Path to the .pack file
    pack: PathBuf,

    /// Fully resolve all deltas and report resolved object sizes.
    /// WARNING: loads all objects into memory (like the server does).
    #[arg(long)]
    resolve: bool,
}

#[derive(Default)]
struct TypeStats {
    count: u64,
    total_size: u64,
    min_size: u64,
    max_size: u64,
}

impl TypeStats {
    fn new() -> Self {
        Self {
            min_size: u64::MAX,
            ..Default::default()
        }
    }

    fn record(&mut self, size: u64) {
        self.count += 1;
        self.total_size += size;
        self.min_size = self.min_size.min(size);
        self.max_size = self.max_size.max(size);
    }

    fn avg(&self) -> u64 {
        if self.count == 0 {
            0
        } else {
            self.total_size / self.count
        }
    }
}

fn main() {
    let args = Args::parse();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    runtime.block_on(async {
        let result = if args.resolve {
            run_resolve(&args.pack).await
        } else {
            run(&args.pack).await
        };
        if let Err(e) = result {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    });
}

async fn run(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let file = tokio::fs::File::open(path).await?;
    let file_size = file.metadata().await?.len();
    let reader = BufReader::with_capacity(256 * 1024, file);

    let mut stream = PackfileStream::new(reader);
    let count = stream.read_header().await?;

    eprintln!("Packfile: {}", path.display());
    eprintln!("Compressed size: {}", fmt_bytes(file_size));
    eprintln!("Declared objects: {count}");
    eprintln!();

    // Per-type stats, keyed by type_name for stable ordering later.
    let mut stats: HashMap<&str, TypeStats> = HashMap::new();

    // Delta-chain tracking (OFS_DELTA only; REF_DELTA chains can't be traced
    // without resolving SHA-1s, so we just count them).
    let mut ofs_edges: Vec<(usize, usize)> = Vec::new(); // (obj_offset, base_offset)
    let mut ref_delta_count: u64 = 0;

    // Size-distribution buckets:
    //   <1K, 1-10K, 10-100K, 100K-1M, 1-10M, 10-100M, 100M-1G, >=1G
    let mut size_buckets: [u64; 8] = [0; 8];

    let mut processed: u32 = 0;
    let start = std::time::Instant::now();
    let mut last_report = start;

    while let Some(obj) = stream.next_object().await? {
        let size = obj.data.len() as u64;
        let type_name = type_label(obj.obj_type);

        stats
            .entry(type_name)
            .or_insert_with(TypeStats::new)
            .record(size);

        if let Some(base_off) = obj.base_offset {
            ofs_edges.push((obj.pack_offset, base_off));
        }
        if obj.base_ref.is_some() {
            ref_delta_count += 1;
        }

        size_buckets[size_bucket(size)] += 1;
        processed += 1;

        // Progress every 5 s.
        let now = std::time::Instant::now();
        if now.duration_since(last_report).as_secs() >= 5 {
            let pct = (processed as f64 / count as f64) * 100.0;
            let elapsed = now.duration_since(start).as_secs_f64();
            eprintln!("  [{pct:5.1}%] {processed}/{count} objects in {elapsed:.1}s");
            last_report = now;
        }

        // `obj.data` is dropped here — only metadata retained.
    }

    let elapsed = start.elapsed();

    // ---- Report ----

    println!("=== Packfile analysis ===");
    println!();
    println!("File:            {}", path.display());
    println!("Compressed size: {}", fmt_bytes(file_size));
    println!("Objects:         {processed}");
    println!("Parse time:      {:.2}s", elapsed.as_secs_f64());
    println!();

    // -- counts by type --
    println!("--- Object counts by type ---");
    let mut total_decompressed: u64 = 0;
    for name in TYPE_ORDER {
        if let Some(s) = stats.get(name) {
            println!(
                "  {name:12} {count:>10}  total={total:>12}  avg={avg:>10}  min={min:>10}  max={max:>10}",
                count = s.count,
                total = fmt_bytes(s.total_size),
                avg = fmt_bytes(s.avg()),
                min = fmt_bytes(if s.min_size == u64::MAX {
                    0
                } else {
                    s.min_size
                }),
                max = fmt_bytes(s.max_size),
            );
            total_decompressed += s.total_size;
        }
    }
    println!();
    println!("Total decompressed: {}", fmt_bytes(total_decompressed));
    if file_size > 0 {
        println!(
            "Compression ratio:  {:.2}x",
            total_decompressed as f64 / file_size as f64
        );
    }
    println!();

    // -- size distribution --
    println!("--- Size distribution ---");
    let labels = [
        "<1 KiB",
        "1-10 KiB",
        "10-100 KiB",
        "100 KiB-1 MiB",
        "1-10 MiB",
        "10-100 MiB",
        "100 MiB-1 GiB",
        ">=1 GiB",
    ];
    for (i, label) in labels.iter().enumerate() {
        if size_buckets[i] > 0 {
            let pct = (size_buckets[i] as f64 / processed as f64) * 100.0;
            println!("  {label:>16}: {n:>10} ({pct:5.1}%)", n = size_buckets[i]);
        }
    }
    println!();

    // -- delta analysis --
    println!("--- Delta analysis ---");
    let total_deltas = ofs_edges.len() as u64 + ref_delta_count;
    let base_objects = processed as u64 - total_deltas;
    println!("  Base objects:  {base_objects}");
    println!("  OFS_DELTA:     {}", ofs_edges.len());
    println!("  REF_DELTA:     {ref_delta_count}");
    if processed > 0 {
        println!(
            "  Delta ratio:   {:.1}%",
            (total_deltas as f64 / processed as f64) * 100.0
        );
    }

    // OFS_DELTA chain depths.
    if !ofs_edges.is_empty() {
        let offset_to_base: HashMap<usize, usize> = ofs_edges.iter().copied().collect();

        let mut depth_counts: HashMap<u32, u64> = HashMap::new();
        let mut max_depth: u32 = 0;

        for &(obj_off, _) in &ofs_edges {
            let mut depth = 0u32;
            let mut cur = obj_off;
            while let Some(&base) = offset_to_base.get(&cur) {
                depth += 1;
                cur = base;
                if depth > 1000 {
                    break;
                }
            }
            max_depth = max_depth.max(depth);
            *depth_counts.entry(depth).or_insert(0) += 1;
        }

        println!();
        println!("  OFS_DELTA chain depths:");
        let mut depths: Vec<u32> = depth_counts.keys().copied().collect();
        depths.sort_unstable();
        for d in &depths {
            println!("    depth {d:3}: {:>10}", depth_counts[d]);
        }
        println!("    max depth: {max_depth}");
    }
    println!();

    // -- memory projections --
    println!("=== Memory projections ===");
    println!();

    // Overhead per RawPackObject (struct fields + Vec heap header + alignment).
    let per_obj: u64 = 80;
    // HashMap entry overhead (key=20 + type enum + data Vec + bucket metadata).
    let hm_entry: u64 = 56;

    let current_peak =
        total_decompressed + (processed as u64 * per_obj) + (processed as u64 * hm_entry);

    println!("Current strategy (buffer all objects + HashMap):");
    println!("  Decompressed data:   {}", fmt_bytes(total_decompressed));
    println!(
        "  Vec<RawPackObject>:  {}",
        fmt_bytes(processed as u64 * per_obj)
    );
    println!(
        "  HashMap overhead:    {}",
        fmt_bytes(processed as u64 * hm_entry)
    );
    println!("  Estimated peak:      {}", fmt_bytes(current_peak));
    println!();

    // Streaming strategy: only non-delta objects need to be kept until tree
    // conversion is done; deltas are resolved and discarded. In practice the
    // bottleneck is blobs referenced by the tree, but the worst case is all
    // base objects.
    let delta_data_size: u64 = stats.get("ofs_delta").map_or(0, |s| s.total_size)
        + stats.get("ref_delta").map_or(0, |s| s.total_size);

    let base_data_size = total_decompressed - delta_data_size;

    println!("Streaming strategy (resolve deltas incrementally, keep only tree+blob):");
    println!("  Base object data:    {}", fmt_bytes(base_data_size));
    println!("  Delta instructions:  {}", fmt_bytes(delta_data_size));
    println!(
        "  Metadata overhead:   {}",
        fmt_bytes(processed as u64 * 16)
    );
    println!(
        "  Estimated peak:      {}",
        fmt_bytes(base_data_size + processed as u64 * 16)
    );
    println!(
        "  Savings vs current:  {}",
        fmt_bytes(current_peak.saturating_sub(base_data_size + processed as u64 * 16))
    );

    Ok(())
}

/// Two-pass delta resolution: measures resolved object sizes without holding
/// all data in memory simultaneously.
///
/// Pass 1: stream through, build reference counts (which pack offsets are used
/// as delta bases and how many times).
/// Pass 2: stream through again, resolve deltas using a bounded base cache
/// that evicts entries once their refcount drops to zero.
async fn run_resolve(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let file = tokio::fs::File::open(path).await?;
    let file_size = file.metadata().await?.len();

    eprintln!("Packfile: {}", path.display());
    eprintln!("Compressed size: {}", fmt_bytes(file_size));

    // --- Pass 1: build reference counts ---
    eprintln!("Pass 1: scanning delta references...");
    let reader1 = BufReader::with_capacity(256 * 1024, file);
    let mut stream1 = PackfileStream::new(reader1);
    let count = stream1.read_header().await?;

    // refcounts[pack_offset] = number of future deltas that reference this offset
    let mut refcounts: HashMap<usize, u32> = HashMap::new();
    let mut has_ref_delta = false;

    while let Some(obj) = stream1.next_object().await? {
        if let Some(base_off) = obj.base_offset {
            *refcounts.entry(base_off).or_insert(0) += 1;
        }
        if obj.base_ref.is_some() {
            has_ref_delta = true;
        }
    }

    let total_bases_referenced = refcounts.len();
    eprintln!(
        "  {count} objects, {total_bases_referenced} unique base offsets referenced, \
         REF_DELTA: {}",
        if has_ref_delta { "yes" } else { "no" }
    );

    if has_ref_delta {
        eprintln!("  WARNING: REF_DELTA present — cannot resolve with streaming approach");
        return Ok(());
    }

    // --- Pass 2: resolve deltas with bounded base cache ---
    eprintln!("Pass 2: resolving deltas with eviction...");
    let file2 = tokio::fs::File::open(path).await?;
    let reader2 = BufReader::with_capacity(256 * 1024, file2);
    let mut stream2 = PackfileStream::new(reader2);
    stream2.read_header().await?;

    // base_cache: pack_offset → (type, data) — only entries still needed as bases
    let mut base_cache: HashMap<usize, (GitObjectType, Vec<u8>)> = HashMap::new();
    let mut cache_bytes: u64 = 0;
    let mut peak_cache_bytes: u64 = 0;
    let mut evictions: u64 = 0;

    let mut stats: HashMap<&str, TypeStats> = HashMap::new();
    let mut size_buckets: [u64; 8] = [0; 8];
    let mut processed: u32 = 0;
    let start = std::time::Instant::now();
    let mut last_report = start;

    while let Some(obj) = stream2.next_object().await? {
        let (resolved_type, resolved_size) = if obj.obj_type == GitObjectType::OfsDelta {
            let base_offset = obj.base_offset.unwrap();
            let (base_type, base_data) = base_cache.get(&base_offset).ok_or_else(|| {
                format!(
                    "base at offset {base_offset} not in cache for delta at {}",
                    obj.pack_offset
                )
            })?;
            let resolved = fetch_git::delta::apply_delta(base_data, &obj.data)?;
            let resolved_size = resolved.len() as u64;
            let resolved_type = *base_type;

            // Decrement refcount for the base, evict if zero.
            if let Some(rc) = refcounts.get_mut(&base_offset) {
                *rc -= 1;
                if *rc == 0 {
                    if let Some((_, evicted)) = base_cache.remove(&base_offset) {
                        cache_bytes -= evicted.len() as u64;
                        evictions += 1;
                    }
                    refcounts.remove(&base_offset);
                }
            }

            // If this resolved object is itself a base for future deltas, cache it.
            if refcounts.contains_key(&obj.pack_offset) {
                cache_bytes += resolved_size;
                peak_cache_bytes = peak_cache_bytes.max(cache_bytes);
                base_cache.insert(obj.pack_offset, (resolved_type, resolved));
            }

            (resolved_type, resolved_size)
        } else {
            let size = obj.data.len() as u64;
            let obj_type = obj.obj_type;

            // Cache if referenced as a base.
            if refcounts.contains_key(&obj.pack_offset) {
                cache_bytes += size;
                peak_cache_bytes = peak_cache_bytes.max(cache_bytes);
                base_cache.insert(obj.pack_offset, (obj_type, obj.data));
            }

            (obj_type, size)
        };

        stats
            .entry(type_label(resolved_type))
            .or_insert_with(TypeStats::new)
            .record(resolved_size);
        size_buckets[size_bucket(resolved_size)] += 1;
        processed += 1;

        let now = std::time::Instant::now();
        if now.duration_since(last_report).as_secs() >= 5 {
            let pct = (processed as f64 / count as f64) * 100.0;
            let elapsed = now.duration_since(start).as_secs_f64();
            eprintln!(
                "  [{pct:5.1}%] {processed}/{count} in {elapsed:.1}s  \
                 cache={} ({} entries)  peak={}  rss={} MiB",
                fmt_bytes(cache_bytes),
                base_cache.len(),
                fmt_bytes(peak_cache_bytes),
                rss_mib().unwrap_or(0),
            );
            last_report = now;
        }
    }

    let elapsed = start.elapsed();

    println!("=== Resolved packfile analysis (two-pass) ===");
    println!();
    println!("File:            {}", path.display());
    println!("Compressed size: {}", fmt_bytes(file_size));
    println!("Objects:         {processed}");
    println!("Resolve time:    {:.2}s", elapsed.as_secs_f64());
    println!("Peak base cache: {}", fmt_bytes(peak_cache_bytes));
    println!(
        "Final cache:     {} ({} entries)",
        fmt_bytes(cache_bytes),
        base_cache.len()
    );
    println!("Evictions:       {evictions}");
    println!("RSS:             {} MiB", rss_mib().unwrap_or(0));
    println!();

    println!("--- Resolved object counts by type ---");
    let mut total_resolved: u64 = 0;
    for name in TYPE_ORDER {
        if let Some(s) = stats.get(name) {
            println!(
                "  {name:12} {count:>10}  total={total:>12}  avg={avg:>10}  max={max:>10}",
                count = s.count,
                total = fmt_bytes(s.total_size),
                avg = fmt_bytes(s.avg()),
                max = fmt_bytes(s.max_size),
            );
            total_resolved += s.total_size;
        }
    }
    println!();
    println!("Total resolved data: {}", fmt_bytes(total_resolved));

    println!();
    println!("--- Size distribution (resolved) ---");
    let labels = [
        "<1 KiB",
        "1-10 KiB",
        "10-100 KiB",
        "100 KiB-1 MiB",
        "1-10 MiB",
        "10-100 MiB",
        "100 MiB-1 GiB",
        ">=1 GiB",
    ];
    for (i, label) in labels.iter().enumerate() {
        if size_buckets[i] > 0 {
            let pct = (size_buckets[i] as f64 / processed as f64) * 100.0;
            println!("  {label:>16}: {n:>10} ({pct:5.1}%)", n = size_buckets[i]);
        }
    }

    Ok(())
}

fn rss_mib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.trim().strip_suffix("kB")?.trim().parse().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

// ---- helpers ----

const TYPE_ORDER: &[&str] = &["commit", "tree", "blob", "tag", "ofs_delta", "ref_delta"];

fn type_label(t: GitObjectType) -> &'static str {
    match t {
        GitObjectType::Commit => "commit",
        GitObjectType::Tree => "tree",
        GitObjectType::Blob => "blob",
        GitObjectType::Tag => "tag",
        GitObjectType::OfsDelta => "ofs_delta",
        GitObjectType::RefDelta => "ref_delta",
    }
}

fn size_bucket(size: u64) -> usize {
    if size < 1024 {
        0
    } else if size < 10 * 1024 {
        1
    } else if size < 100 * 1024 {
        2
    } else if size < 1024 * 1024 {
        3
    } else if size < 10 * 1024 * 1024 {
        4
    } else if size < 100 * 1024 * 1024 {
        5
    } else if size < 1024 * 1024 * 1024 {
        6
    } else {
        7
    }
}

fn fmt_bytes(n: u64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{:.2} GiB", n as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if n >= 1024 * 1024 {
        format!("{:.1} MiB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.1} KiB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}
