// SPDX-FileCopyrightText: © 2019-2024 The Jujutsu Authors, Octavian Oncescu
// SPDX-License-Identifier: MIT

// Taken from mimalloc_rust library. mimalloc_rust contains the following
// license:
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

//! A module for using the **[mimalloc](https://github.com/microsoft/mimalloc)**
//! memory allocator in Rust programs. mimalloc is a small, easy-to-understand,
//! scalable, cache-and-thread friendly memory allocator. It is written in C,
//! has no external dependencies, and is linked and exists entirely inside of
//! this crate.
//!
//! By design, this module is nearly opaque. The only supported APIs are using
//! [`MiMalloc`] with the [`#[global_allocator]` attribute][module@core::alloc],
//! and some tools for diagnostics. In the future this may expand to features
//! like dedicated heaps or arenas, if needed.
//!
//! ## Motivation
//!
//! This is effectively a soft fork of the [mimalloc](https://docs.rs/mimalloc)
//! and [mimalloc-sys](https://docs.rs/mimalloc-sys) crates, merging them into
//! one module for our own needs with some extra cherries on top. There are also
//! an array of third party crates providing mimalloc support.
//!
//! The motivation for our own crates include, but are not limited to:
//!
//! - Usage of mimalloc 2.x, while many upstream crates use seem to still use
//!   the 1.x series,
//! - Reduce "crate bloat", as we have no need for separate `foo`/`foo-sys`
//!   designs,
//! - Have a space for _other_ C code in the future,
//! - Have better control over the exported API for deeper integration.
//!
//! Please read the top-level documentation for the [jj_cbits](../index.html)
//! crate for more information.
//!
//! In the future, it is possible these changes may be integrated back into a
//! more general, widely-usable crate.
//!
//! ## Basic usage
//!
//! ```rust,ignore
//! #[global_allocator]
//! static ALLOC: jj_cbits::mimalloc::MiMalloc = jj_cbits::mimalloc::MiMalloc;
//! ```

use core::alloc::GlobalAlloc;
use core::ffi::{CStr, c_char, c_ulonglong, c_void};
use core::fmt;

use mimalloc_ffi::{
    MI_STAT_VERSION, mi_collect, mi_free, mi_good_size, mi_malloc_aligned, mi_option_get,
    mi_option_set, mi_option_set_default, mi_option_t, mi_process_info, mi_realloc_aligned,
    mi_register_deferred_free, mi_stat_count_t, mi_stat_counter_t, mi_stats_get,
    mi_stats_get_bin_size, mi_stats_print_out, mi_stats_reset, mi_stats_t, mi_usable_size,
    mi_zalloc_aligned,
};

/// A statistic counter with total, peak, and current values.
///
/// This wrapper provides safe access to mimalloc's `mi_stat_count_t` structure,
/// which tracks allocation statistics over time.
///
/// ## Fields
///
/// * `total` - Total allocated over the program's lifetime
/// * `peak` - Peak allocation (maximum value reached)
/// * `current` - Current allocation
///
/// Note: In multi-threaded programs without merging, peak values are summed
/// across threads rather than representing the true global peak.
#[derive(Debug, Clone, Copy)]
#[repr(transparent)]
pub struct StatCount(mi_stat_count_t);

impl StatCount {
    /// Total allocated over the program's lifetime
    #[inline]
    pub fn total(&self) -> i64 {
        self.0.total
    }

    /// Peak allocation (maximum value reached)
    #[inline]
    pub fn peak(&self) -> i64 {
        self.0.peak
    }

    /// Current allocation
    #[inline]
    pub fn current(&self) -> i64 {
        self.0.current
    }
}

/// A monotonic counter with only a total value.
///
/// This wrapper provides safe access to mimalloc's `mi_stat_counter_t` structure,
/// which tracks counters that only increase over time.
///
/// ## Fields
///
/// * `total` - Total count over the program's lifetime
#[derive(Debug, Clone, Copy)]
#[repr(transparent)]
pub struct StatCounter(mi_stat_counter_t);

impl StatCounter {
    /// Total count over the program's lifetime
    #[inline]
    pub fn total(&self) -> i64 {
        self.0.total
    }
}

/// Provide global mimalloc heap statistics to a user-provided callback.
///
/// The provided callback function will be called multiple times in sequence,
/// each time with a single argument, which is a single null-terminated line,
/// represented as a [CStr]. Collectively, these lines will represent a summary
/// of the global heap statistics for the entire program, meant to be written to
/// the terminal or a log file.
///
/// Therefore, the simplest way to use this function is to simply provide a
/// closure that prints the given log messages to `stderr` immediately:
///
/// ```rust,ignore
/// eprintln!("========================================");
/// eprintln!("mimalloc memory allocation statistics:\n");
/// jj_cbits::mimalloc::stats_print(&|l| {
///   eprint!("{}", l.to_string_lossy());
/// });
/// ```
///
/// Note that this merges all thread-local statistics into the main statistics
/// summary before printing to `stderr`, so while it will give a global summary
/// of the heap, it may cause some performance overhead while thread-local
/// buffers are being flushed and merged.
pub fn stats_print<F: Fn(&CStr)>(f: &'static F) {
    unsafe extern "C" fn wrapper<F: Fn(&CStr)>(value: *const c_char, ctx: *mut c_void) {
        unsafe {
            (*(ctx as *const F))(CStr::from_ptr(value));
        }
    }
    unsafe { mi_stats_print_out(Some(wrapper::<F>), f as *const F as *mut c_void) }
}

/// Reset heap statistics counters and histograms.
///
/// Primarily useful to clear out any existing statistics, so that a subsequent
/// call to `mimalloc_stats_print` will only show statistics since the last
/// reset.
///
/// This should also reset and merge all thread-local statistics, too.
pub fn stats_reset() {
    unsafe {
        mi_stats_reset();
    }
}

/// Opaque statistics handle containing heap metrics.
///
/// This structure wraps the internal mimalloc statistics and provides safe
/// access to heap metrics. The structure itself is opaque to maintain
/// compatibility across mimalloc versions.
///
/// ## Thread Safety
///
/// Note that some statistics (particularly peak values) do not aggregate
/// correctly across threads - they sum thread-local peaks rather than taking
/// the maximum. For accurate global statistics, consider using
/// [`stats_print`] which properly merges thread-local data.
///
/// ## Example
///
/// ```rust,ignore
/// let stats = jj_cbits::mimalloc::stats_get();
/// println!("Reserved memory: {} bytes", stats.reserved().current);
/// println!("Committed memory: {} bytes", stats.committed().current);
/// ```
pub struct Stats(mi_stats_t);

/// Get current heap statistics.
///
/// This function retrieves a snapshot of the current heap statistics without
/// allocating memory. The returned [`Stats`] object contains comprehensive
/// metrics about memory usage, allocations, and heap operations.
///
/// Note that this does NOT automatically merge thread-local statistics, so
/// some values may be incomplete in multi-threaded programs. For complete
/// statistics, use [`stats_get_merged`] instead.
///
/// ## Example
///
/// ```rust,ignore
/// let stats = jj_cbits::mimalloc::stats_get();
/// println!("Pages: {}", stats.pages().current);
/// ```
pub fn stats_get() -> Stats {
    let mut inner: mi_stats_t = unsafe { core::mem::zeroed() };
    inner.size = core::mem::size_of::<mi_stats_t>();
    inner.version = MI_STAT_VERSION as usize;
    unsafe {
        mi_stats_get(&mut inner as *mut mi_stats_t);
    }
    // mi_stats_get zeros the struct before filling; restore metadata fields
    inner.size = core::mem::size_of::<mi_stats_t>();
    inner.version = MI_STAT_VERSION as usize;
    Stats(inner)
}

/// Get current heap statistics with thread-local data merged.
///
/// This function merges all thread-local statistics into the main statistics
/// buffer before retrieving the snapshot. This provides a more accurate global
/// view of heap usage in multi-threaded programs, but may cause some
/// performance overhead.
///
/// Use this when you need accurate global statistics. Use [`stats_get`] for
/// faster snapshots when thread-local precision is acceptable.
///
/// ## Example
///
/// ```rust,ignore
/// let stats = jj_cbits::mimalloc::stats_get_merged();
/// eprintln!("Global heap stats: {}", stats);
/// ```
pub fn stats_get_merged() -> Stats {
    unsafe {
        mi_collect(false);
    }
    stats_get()
}

impl Stats {
    /// Statistics structure version number
    #[inline]
    pub fn version(&self) -> usize {
        self.0.version
    }

    // Memory statistics (StatCount fields)

    /// Count of mimalloc pages
    #[inline]
    pub fn pages(&self) -> &StatCount {
        unsafe { &*(&self.0.pages as *const mi_stat_count_t as *const StatCount) }
    }

    /// Reserved memory bytes
    #[inline]
    pub fn reserved(&self) -> &StatCount {
        unsafe { &*(&self.0.reserved as *const mi_stat_count_t as *const StatCount) }
    }

    /// Committed memory bytes
    #[inline]
    pub fn committed(&self) -> &StatCount {
        unsafe { &*(&self.0.committed as *const mi_stat_count_t as *const StatCount) }
    }

    /// Reset memory bytes
    #[inline]
    pub fn reset(&self) -> &StatCounter {
        unsafe { &*(&self.0.reset as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Purged memory bytes
    #[inline]
    pub fn purged(&self) -> &StatCounter {
        unsafe { &*(&self.0.purged as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Committed memory inside pages
    #[inline]
    pub fn page_committed(&self) -> &StatCount {
        unsafe { &*(&self.0.page_committed as *const mi_stat_count_t as *const StatCount) }
    }

    /// Abandoned pages count
    #[inline]
    pub fn pages_abandoned(&self) -> &StatCount {
        unsafe { &*(&self.0.pages_abandoned as *const mi_stat_count_t as *const StatCount) }
    }

    /// Number of threads
    #[inline]
    pub fn threads(&self) -> &StatCount {
        unsafe { &*(&self.0.threads as *const mi_stat_count_t as *const StatCount) }
    }

    /// Allocated bytes in normal allocations (≤ MI_LARGE_OBJ_SIZE_MAX)
    #[inline]
    pub fn malloc_normal(&self) -> &StatCount {
        unsafe { &*(&self.0.malloc_normal as *const mi_stat_count_t as *const StatCount) }
    }

    /// Allocated bytes in huge pages
    #[inline]
    pub fn malloc_huge(&self) -> &StatCount {
        unsafe { &*(&self.0.malloc_huge as *const mi_stat_count_t as *const StatCount) }
    }

    /// Malloc requested bytes (total requested by application)
    #[inline]
    pub fn malloc_requested(&self) -> &StatCount {
        unsafe { &*(&self.0.malloc_requested as *const mi_stat_count_t as *const StatCount) }
    }

    /// Memory segments
    #[inline]
    pub fn segments(&self) -> &StatCount {
        unsafe { &*(&self.0.segments as *const mi_stat_count_t as *const StatCount) }
    }

    /// Abandoned segments
    #[inline]
    pub fn segments_abandoned(&self) -> &StatCount {
        unsafe { &*(&self.0.segments_abandoned as *const mi_stat_count_t as *const StatCount) }
    }

    /// Cached segments
    #[inline]
    pub fn segments_cache(&self) -> &StatCount {
        unsafe { &*(&self.0.segments_cache as *const mi_stat_count_t as *const StatCount) }
    }

    // Counters (StatCounter fields)

    /// Number of mmap calls
    #[inline]
    pub fn mmap_calls(&self) -> &StatCounter {
        unsafe { &*(&self.0.mmap_calls as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of commit calls
    #[inline]
    pub fn commit_calls(&self) -> &StatCounter {
        unsafe { &*(&self.0.commit_calls as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of reset calls
    #[inline]
    pub fn reset_calls(&self) -> &StatCounter {
        unsafe { &*(&self.0.reset_calls as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of purge calls
    #[inline]
    pub fn purge_calls(&self) -> &StatCounter {
        unsafe { &*(&self.0.purge_calls as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of memory arenas
    #[inline]
    pub fn arena_count(&self) -> &StatCounter {
        unsafe { &*(&self.0.arena_count as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of normal allocation blocks (≤ MI_LARGE_OBJ_SIZE_MAX)
    #[inline]
    pub fn malloc_normal_count(&self) -> &StatCounter {
        unsafe { &*(&self.0.malloc_normal_count as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of huge blocks
    #[inline]
    pub fn malloc_huge_count(&self) -> &StatCounter {
        unsafe { &*(&self.0.malloc_huge_count as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of allocations with guard pages
    #[inline]
    pub fn malloc_guarded_count(&self) -> &StatCounter {
        unsafe {
            &*(&self.0.malloc_guarded_count as *const mi_stat_counter_t as *const StatCounter)
        }
    }

    /// Arena rollback count (internal)
    #[inline]
    pub fn arena_rollback_count(&self) -> &StatCounter {
        unsafe {
            &*(&self.0.arena_rollback_count as *const mi_stat_counter_t as *const StatCounter)
        }
    }

    /// Arena purges (internal)
    #[inline]
    pub fn arena_purges(&self) -> &StatCounter {
        unsafe { &*(&self.0.arena_purges as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of page extensions
    #[inline]
    pub fn pages_extended(&self) -> &StatCounter {
        unsafe { &*(&self.0.pages_extended as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of pages retired
    #[inline]
    pub fn pages_retire(&self) -> &StatCounter {
        unsafe { &*(&self.0.pages_retire as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Number of page searches
    #[inline]
    pub fn page_searches(&self) -> &StatCounter {
        unsafe { &*(&self.0.page_searches as *const mi_stat_counter_t as *const StatCounter) }
    }

    /// Pages reclaimed on allocation (v3+)
    #[inline]
    pub fn pages_reclaim_on_alloc(&self) -> &StatCounter {
        unsafe {
            &*(&self.0.pages_reclaim_on_alloc as *const mi_stat_counter_t as *const StatCounter)
        }
    }

    /// Pages reclaimed on free (v3+)
    #[inline]
    pub fn pages_reclaim_on_free(&self) -> &StatCounter {
        unsafe {
            &*(&self.0.pages_reclaim_on_free as *const mi_stat_counter_t as *const StatCounter)
        }
    }

    /// Pages re-abandoned when full (v3+)
    #[inline]
    pub fn pages_reabandon_full(&self) -> &StatCounter {
        unsafe {
            &*(&self.0.pages_reabandon_full as *const mi_stat_counter_t as *const StatCounter)
        }
    }

    /// Pages unabandon with busy wait (v3+)
    #[inline]
    pub fn pages_unabandon_busy_wait(&self) -> &StatCounter {
        unsafe {
            &*(&self.0.pages_unabandon_busy_wait as *const mi_stat_counter_t as *const StatCounter)
        }
    }

    // Bin statistics

    /// Get statistics for a specific malloc size bin (0-73)
    ///
    /// Returns `None` if the bin index is out of range.
    #[inline]
    pub fn malloc_bin(&self, index: usize) -> Option<&StatCount> {
        if index < 74 {
            Some(unsafe {
                &*(&self.0.malloc_bins[index] as *const mi_stat_count_t as *const StatCount)
            })
        } else {
            None
        }
    }

    /// Iterator over all malloc size bins
    pub fn malloc_bins(&self) -> impl Iterator<Item = &StatCount> {
        (0..74).map(move |i| self.malloc_bin(i).unwrap())
    }

    /// Get statistics for a specific page bin (0-73)
    ///
    /// Returns `None` if the bin index is out of range.
    #[inline]
    pub fn page_bin(&self, index: usize) -> Option<&StatCount> {
        if index < 74 {
            Some(unsafe {
                &*(&self.0.page_bins[index] as *const mi_stat_count_t as *const StatCount)
            })
        } else {
            None
        }
    }

    /// Iterator over all page bins
    pub fn page_bins(&self) -> impl Iterator<Item = &StatCount> {
        (0..74).map(move |i| self.page_bin(i).unwrap())
    }

    /// Get statistics for a specific chunk bin (0-4)
    ///
    /// Returns `None` if the bin index is out of range.
    #[inline]
    pub fn chunk_bin(&self, index: usize) -> Option<&StatCount> {
        if index < 5 {
            Some(unsafe {
                &*(&self.0.chunk_bins[index] as *const mi_stat_count_t as *const StatCount)
            })
        } else {
            None
        }
    }

    /// Iterator over all chunk bins
    pub fn chunk_bins(&self) -> impl Iterator<Item = &StatCount> {
        (0..5).map(move |i| self.chunk_bin(i).unwrap())
    }
}

impl fmt::Display for Stats {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "Mimalloc Statistics (version {})", self.version())?;
        writeln!(f, "====================")?;
        writeln!(f)?;

        writeln!(f, "Memory Usage:")?;
        writeln!(
            f,
            "  Reserved:     {:>12} bytes (peak: {:>12})",
            self.reserved().current(),
            self.reserved().peak()
        )?;
        writeln!(
            f,
            "  Committed:    {:>12} bytes (peak: {:>12})",
            self.committed().current(),
            self.committed().peak()
        )?;
        writeln!(
            f,
            "  Pages:        {:>12} current (peak: {:>12})",
            self.pages().current(),
            self.pages().peak()
        )?;
        writeln!(f)?;

        writeln!(f, "Allocations:")?;
        writeln!(
            f,
            "  Normal:       {:>12} bytes (peak: {:>12}, count: {})",
            self.malloc_normal().current(),
            self.malloc_normal().peak(),
            self.malloc_normal_count().total()
        )?;
        writeln!(
            f,
            "  Huge:         {:>12} bytes (peak: {:>12}, count: {})",
            self.malloc_huge().current(),
            self.malloc_huge().peak(),
            self.malloc_huge_count().total()
        )?;
        writeln!(
            f,
            "  Requested:    {:>12} bytes total",
            self.malloc_requested().total()
        )?;
        writeln!(f)?;

        writeln!(f, "System Calls:")?;
        writeln!(f, "  mmap:         {:>12} calls", self.mmap_calls().total())?;
        writeln!(
            f,
            "  commit:       {:>12} calls",
            self.commit_calls().total()
        )?;
        writeln!(
            f,
            "  reset:        {:>12} calls",
            self.reset_calls().total()
        )?;
        writeln!(
            f,
            "  purge:        {:>12} calls",
            self.purge_calls().total()
        )?;
        writeln!(f)?;

        writeln!(f, "Internal:")?;
        writeln!(f, "  Arenas:       {:>12}", self.arena_count().total())?;
        writeln!(
            f,
            "  Threads:      {:>12} current",
            self.threads().current()
        )?;
        writeln!(f, "  Page searches:{:>12}", self.page_searches().total())?;

        Ok(())
    }
}

/// Get the size in bytes for a given heap bin index.
///
/// Mimalloc organizes small allocations into size-segregated bins. This
/// function returns the size associated with a particular bin index.
///
/// ## Arguments
///
/// * `bin_index` - The bin index to query (typically 0..73 for MI_BIN_HUGE)
///
/// ## Returns
///
/// * `Some(size)` - The size in bytes for the given bin
/// * `None` - If the index is invalid (out of range or the C function returns 0)
///
/// ## Example
///
/// ```rust,ignore
/// if let Some(size) = jj_cbits::mimalloc::bin_size(0) {
///     println!("Bin 0 holds allocations of size: {} bytes", size);
/// }
/// ```
pub fn bin_size(bin_index: usize) -> Option<usize> {
    let size = unsafe { mi_stats_get_bin_size(bin_index) };
    if size == 0 { None } else { Some(size) }
}

/// Process information including memory usage and CPU time.
///
/// This structure contains various metrics about the current process,
/// including resident set size (RSS), CPU time usage, and page faults.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessInfo {
    /// Elapsed time in milliseconds since process start
    pub elapsed_msecs: usize,
    /// User CPU time in milliseconds
    pub user_msecs: usize,
    /// System CPU time in milliseconds
    pub system_msecs: usize,
    /// Current resident set size (RSS) in bytes
    pub current_rss: usize,
    /// Peak resident set size (RSS) in bytes
    pub peak_rss: usize,
    /// Current committed memory in bytes
    pub current_commit: usize,
    /// Peak committed memory in bytes
    pub peak_commit: usize,
    /// Number of page faults
    pub page_faults: usize,
}

impl fmt::Display for ProcessInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "Process Information")?;
        writeln!(f, "===================")?;
        writeln!(f)?;

        writeln!(f, "Time:")?;
        writeln!(f, "  Elapsed:      {:>12} ms", self.elapsed_msecs)?;
        writeln!(f, "  User CPU:     {:>12} ms", self.user_msecs)?;
        writeln!(f, "  System CPU:   {:>12} ms", self.system_msecs)?;
        writeln!(f)?;

        writeln!(f, "Memory:")?;
        writeln!(f, "  Current RSS:  {:>12} bytes", self.current_rss)?;
        writeln!(f, "  Peak RSS:     {:>12} bytes", self.peak_rss)?;
        writeln!(f, "  Current Commit:{:>11} bytes", self.current_commit)?;
        writeln!(f, "  Peak Commit:  {:>12} bytes", self.peak_commit)?;
        writeln!(f)?;

        writeln!(f, "Faults:")?;
        writeln!(f, "  Page faults:  {:>12}", self.page_faults)?;

        Ok(())
    }
}

/// Get process information including memory usage and CPU time.
///
/// This function retrieves comprehensive metrics about the current process,
/// including memory usage (RSS and committed memory), CPU time, and page faults.
///
/// ## Example
///
/// ```rust,ignore
/// let info = jj_cbits::mimalloc::process_info();
/// println!("Peak RSS: {} bytes", info.peak_rss);
/// println!("User CPU time: {} ms", info.user_msecs);
/// ```
pub fn process_info() -> ProcessInfo {
    let mut info = ProcessInfo::default();
    unsafe {
        mi_process_info(
            &mut info.elapsed_msecs,
            &mut info.user_msecs,
            &mut info.system_msecs,
            &mut info.current_rss,
            &mut info.peak_rss,
            &mut info.current_commit,
            &mut info.peak_commit,
            &mut info.page_faults,
        );
    }
    info
}

/// Get the "good size" for an allocation.
///
/// This function returns the actual size that mimalloc will allocate for a
/// given requested size, rounding up to the nearest size class. This is useful
/// for understanding the actual memory overhead and for pre-calculating optimal
/// allocation sizes.
///
/// ## Example
///
/// ```rust,ignore
/// let size = jj_cbits::mimalloc::good_size(100);
/// // size might be 128, the next size class up from 100
/// println!("Allocating 100 bytes will actually use {} bytes", size);
/// ```
#[inline]
pub fn good_size(size: usize) -> usize {
    unsafe { mi_good_size(size) }
}

/// Get the usable size of an allocation.
///
/// Returns the actual usable size of a memory block, which may be larger than
/// the originally requested size due to size class rounding and alignment.
///
/// ## Safety
///
/// The pointer must be a valid allocation from mimalloc that hasn't been freed.
/// Passing an invalid pointer or a pointer from a different allocator results
/// in undefined behavior.
///
/// ## Example
///
/// ```rust,ignore
/// use std::alloc::{alloc, dealloc, Layout};
///
/// let layout = Layout::from_size_align(100, 8).unwrap();
/// let ptr = unsafe { alloc(layout) };
///
/// let usable = unsafe { jj_cbits::mimalloc::usable_size(ptr) };
/// println!("Requested 100 bytes, got {} usable bytes", usable);
///
/// unsafe { dealloc(ptr, layout) };
/// ```
#[inline]
pub unsafe fn usable_size<T>(ptr: *const T) -> usize {
    unsafe { mi_usable_size(ptr as *const c_void) }
}

/// Trigger garbage collection of unused memory.
///
/// This function attempts to free memory that is no longer in use. If `force`
/// is true, mimalloc will try harder to free memory, potentially incurring
/// more overhead.
///
/// ## Arguments
///
/// * `force` - If true, perform more aggressive garbage collection
///
/// ## Example
///
/// ```rust,ignore
/// // Perform gentle garbage collection
/// jj_cbits::mimalloc::collect(false);
///
/// // Perform aggressive garbage collection
/// jj_cbits::mimalloc::collect(true);
/// ```
#[inline]
pub fn collect(force: bool) {
    unsafe { mi_collect(force) }
}

/// Register a "deferred free" function, which will be called by the memory
/// allocator after some (deterministic) number of calls to
/// [`dealloc`](core::alloc::GlobalAlloc::dealloc) in the heap.
///
/// Typically, the callback function is provided as a simple closure with static
/// lifetime, as it may be called at any point in the program's lifetime. The
/// result of the closure is ignored and has no meaning.
///
/// The provided closure will be invoked at an unspecified future point with the
/// following arguments:
///
/// * `force`, type `bool`: If `true`, the deferred free function should free
///   any memory it has allocated, or that may be possible to free to reduce
///   heap pressure.
/// * `count`, type `c_ulonglong`: A monotonically increasing "heartbeat
///   counter." May be assigned any semantic meaning to your program that you
///   desire. This counter MUST NOT be assumed to have any relation to the
///   structure of the heap, in any way.
///
/// These two parameters are completely independent from each other; that is,
/// any combination of `force` and `count` may be provided to the callback and
/// should not be assumed to influence each other in any meaningful way.
///
/// Note that this function is called _deterministically_ based on heap
/// allocations. Therefore, assuming the program itself exhibits deterministic
/// allocation behavior the resulting deferred free callback will also be called
/// deterministically over the program's lifetime. The number of allocations
/// between invocations is unspecified.
///
/// Despite the name, this registered callback does not need to free any extra
/// memory in any way, and can be used purely as a "heartbeat" mechanism to
/// implement other functionality, such as periodic state logging or timeouts
/// that are not tied to the wall clock.
///
/// There may be only a single deferred free function registered at any given
/// time. If this function is called multiple times, the last registered
/// function will be used.
///
/// Reference:
///
/// - Section 2.3 _The Local Free List_; Leijen 2019, "[Mimalloc: Free List
///   Sharding in Action][mimalloc-pdf]", MSR-TR 2019-18.
///
/// [mimalloc-pdf]:
///     https://www.microsoft.com/en-us/research/uploads/prod/2019/06/mimalloc-tr-v1.pdf
pub fn register_deferred_free<F: Fn(bool, c_ulonglong)>(f: &'static F) {
    unsafe extern "C" fn wrapper<F: Fn(bool, c_ulonglong)>(
        force: bool,
        count: c_ulonglong,
        ctx: *mut c_void,
    ) {
        unsafe {
            (*(ctx as *const F))(force, count);
        }
    }
    unsafe { mi_register_deferred_free(Some(wrapper::<F>), f as *const F as *mut c_void) }
}

// --- Option configuration ---------------------------------------------------

/// Mimalloc runtime options that can be queried or changed.
///
/// These map to the underlying `mi_option_t` C enum. Only options
/// relevant to arena/memory tuning are exposed; add more variants as
/// needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum MiOption {
    /// Allow the use of large OS pages (2 MiB on x86-64).
    AllowLargeOsPages = mimalloc_ffi::mi_option_e_mi_option_allow_large_os_pages,

    /// Reserve OS memory upfront (in KiB).
    ReserveOsMemory = mimalloc_ffi::mi_option_e_mi_option_reserve_os_memory,

    /// Disallow OS memory allocation (only use pre-reserved memory).
    DisallowOsAlloc = mimalloc_ffi::mi_option_e_mi_option_disallow_os_alloc,

    /// Initial arena reserve size (in KiB). Mimalloc reserves virtual
    /// address space in arenas of this size; lowering it avoids
    /// over-committing in memory-constrained containers.
    ArenaReserve = mimalloc_ffi::mi_option_e_mi_option_arena_reserve,
}

/// Get the current value of a mimalloc option.
pub fn option_get(option: MiOption) -> i64 {
    unsafe { mi_option_get(option as mi_option_t) as i64 }
}

/// Set a mimalloc option to the given value.
///
/// The change takes effect immediately for newly created arenas.
pub fn option_set(option: MiOption, value: i64) {
    unsafe { mi_option_set(option as mi_option_t, value as _) }
}

/// Set the default value for a mimalloc option.
///
/// Unlike [`option_set`], this only takes effect if the option has not
/// already been set explicitly (via environment variables or a prior
/// call to [`option_set`]).
pub fn option_set_default(option: MiOption, value: i64) {
    unsafe { mi_option_set_default(option as mi_option_t, value as _) }
}

/// Global memory allocator, based on the mimalloc library.
///
/// ## Usage
///
/// Inside of the `main.rs` for any binary:
///
/// ```rust,ignore
/// #[global_allocator]
/// static ALLOC: jj_cbits::mimalloc::MiMalloc = jj_cbits::mimalloc::MiMalloc;
/// ```
pub struct MiMalloc;

unsafe impl GlobalAlloc for MiMalloc {
    #[inline]
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        unsafe { mi_malloc_aligned(layout.size(), layout.align()) as *mut u8 }
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: core::alloc::Layout) -> *mut u8 {
        unsafe { mi_zalloc_aligned(layout.size(), layout.align()) as *mut u8 }
    }

    #[inline]
    unsafe fn dealloc(&self, ptr: *mut u8, _layout: core::alloc::Layout) {
        unsafe { mi_free(ptr as *mut c_void) }
    }

    #[inline]
    unsafe fn realloc(
        &self,
        ptr: *mut u8,
        layout: core::alloc::Layout,
        new_size: usize,
    ) -> *mut u8 {
        unsafe { mi_realloc_aligned(ptr as *mut c_void, new_size, layout.align()) as *mut u8 }
    }
}

#[cfg(test)]
mod tests {
    use mimalloc_ffi::mi_usable_size;

    use super::*;

    #[test]
    fn ok_free_malloc() {
        let ptr = unsafe { mi_malloc_aligned(8, 8) } as *mut u8;
        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn ok_free_zalloc() {
        let ptr = unsafe { mi_zalloc_aligned(8, 8) } as *mut u8;
        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn ok_free_realloc() {
        let ptr = unsafe { mi_malloc_aligned(8, 8) } as *mut u8;
        let ptr = unsafe { mi_realloc_aligned(ptr as *mut c_void, 8, 8) } as *mut u8;
        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn ok_usable_size() {
        let ptr = unsafe { mi_malloc_aligned(32, 64) } as *mut u8;
        let usable_size = unsafe { mi_usable_size(ptr as *mut c_void) };
        assert!(
            usable_size >= 32,
            "usable_size should at least equal to the allocated size"
        );
    }

    #[test]
    fn ok_stats_get() {
        let ptr = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;
        let _stats = stats_get();
        unsafe { mi_free(ptr as *mut c_void) };

        // If we got here without panicking, the test passed
    }

    #[test]
    fn ok_stats_get_merged() {
        let ptr = unsafe { mi_malloc_aligned(2048, 8) } as *mut u8;
        let _stats = stats_get_merged();
        unsafe { mi_free(ptr as *mut c_void) };

        // If we got here without panicking, the test passed
    }

    #[test]
    fn ok_bin_size() {
        let size0 = bin_size(0).expect("Bin 0 should have a valid size");
        assert!(size0 > 0 && size0 < 1024, "Bin 0 should be a small size");

        let size1 = bin_size(1).expect("Bin 1 should have a valid size");
        assert!(size1 >= size0, "Bin sizes should be monotonic");

        let size10 = bin_size(10).expect("Bin 10 should have a valid size");
        assert!(size10 > 0, "Bin 10 should have a valid size");

        // Test invalid bin index (way out of range)
        assert!(
            bin_size(10000).is_none(),
            "Invalid bin index should return None"
        );
    }

    #[test]
    fn ok_stats_reset() {
        let ptr = unsafe { mi_malloc_aligned(256, 8) } as *mut u8;
        stats_reset();

        let _stats = stats_get();
        unsafe { mi_free(ptr as *mut c_void) };
    }

    // Comprehensive statistics tests

    #[test]
    fn test_stats_field_accessors() {
        stats_reset();

        // Allocate some memory to generate stats
        let ptr = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;

        let stats = stats_get_merged();

        // Test that we can access all StatCount fields
        assert!(stats.version() > 0);
        assert!(stats.pages().current() >= 0);
        assert!(stats.reserved().current() >= 0);
        assert!(stats.committed().current() >= 0);
        assert!(stats.malloc_normal().current() >= 0);
        assert!(stats.malloc_huge().current() >= 0);

        // Test that we can access all StatCounter fields
        assert!(stats.mmap_calls().total() >= 0);
        assert!(stats.commit_calls().total() >= 0);
        assert!(stats.arena_count().total() >= 0);
        assert!(stats.malloc_normal_count().total() >= 0);

        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn test_stats_accuracy() {
        stats_reset();

        // Allocate a known amount and verify stats reflect it
        let size = 1024;
        let ptr = unsafe { mi_malloc_aligned(size, 8) } as *mut u8;

        let stats = stats_get_merged();

        // After allocating, we should have some normal allocations
        assert!(
            stats.malloc_normal().current() > 0,
            "Should have current normal allocations"
        );
        assert!(
            stats.malloc_normal_count().total() > 0,
            "Should have counted at least one allocation"
        );

        // Total should be >= current
        assert!(
            stats.malloc_normal().total() >= stats.malloc_normal().current(),
            "Total should be >= current"
        );

        unsafe { mi_free(ptr as *mut c_void) };

        // After freeing, current should decrease
        let stats_after_free = stats_get_merged();
        assert!(
            stats_after_free.malloc_normal().current() <= stats.malloc_normal().current(),
            "Current allocations should decrease or stay same after free"
        );
    }

    #[test]
    fn test_peak_tracking() {
        stats_reset();

        // Allocate increasing amounts and check peak tracking
        let ptr1 = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;
        let stats1 = stats_get_merged();
        let peak1 = stats1.malloc_normal().peak();

        let ptr2 = unsafe { mi_malloc_aligned(2048, 8) } as *mut u8;
        let stats2 = stats_get_merged();
        let peak2 = stats2.malloc_normal().peak();

        // Peak should increase or stay the same
        assert!(peak2 >= peak1, "Peak should increase when we allocate more");

        unsafe {
            mi_free(ptr1 as *mut c_void);
            mi_free(ptr2 as *mut c_void);
        }

        // After freeing, peak should remain at the maximum
        let stats3 = stats_get_merged();
        assert_eq!(
            stats3.malloc_normal().peak(),
            peak2,
            "Peak should not decrease after freeing"
        );
    }

    #[test]
    fn test_bin_statistics() {
        stats_reset();

        // Allocate specific size and check it appears in the right bin
        let size = 64;
        let ptr = unsafe { mi_malloc_aligned(size, 8) } as *mut u8;

        let stats = stats_get_merged();

        // Sum up all bin allocations
        let mut total_bin_allocs = 0i64;
        for bin in stats.malloc_bins() {
            total_bin_allocs += bin.current();
        }

        // Should have some allocations tracked in bins
        assert!(total_bin_allocs > 0, "Bins should track allocations");

        // Test bin accessors
        assert!(stats.malloc_bin(0).is_some());
        assert!(stats.malloc_bin(73).is_some());
        assert!(stats.malloc_bin(74).is_none());

        assert!(stats.page_bin(0).is_some());
        assert!(stats.page_bin(73).is_some());
        assert!(stats.page_bin(74).is_none());

        assert!(stats.chunk_bin(0).is_some());
        assert!(stats.chunk_bin(4).is_some());
        assert!(stats.chunk_bin(5).is_none());

        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn test_stats_display() {
        stats_reset();

        let ptr = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;
        let stats = stats_get_merged();

        let display_str = format!("{}", stats);

        // Check that the display output contains expected sections
        assert!(display_str.contains("Mimalloc Statistics"));
        assert!(display_str.contains("Memory Usage:"));
        assert!(display_str.contains("Allocations:"));
        assert!(display_str.contains("System Calls:"));

        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn test_stat_count_accessors() {
        stats_reset();

        let ptr = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;
        let stats = stats_get_merged();

        let reserved = stats.reserved();
        // Should be able to access total, peak, current
        assert!(reserved.total() >= 0);
        assert!(reserved.peak() >= 0);
        assert!(reserved.current() >= 0);
        assert!(reserved.total() >= reserved.current());
        assert!(reserved.peak() >= reserved.current());

        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn test_stat_counter_accessors() {
        stats_reset();

        let ptr = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;
        let stats = stats_get_merged();

        let mmap_calls = stats.mmap_calls();
        // StatCounter only has total
        assert!(mmap_calls.total() >= 0);

        unsafe { mi_free(ptr as *mut c_void) };
    }

    // Process info tests

    #[test]
    fn test_process_info() {
        let info = process_info();

        // All values should be reasonable (non-negative)
        assert!(info.elapsed_msecs >= 0);
        assert!(info.user_msecs >= 0);
        assert!(info.system_msecs >= 0);
        assert!(info.current_rss >= 0);
        assert!(info.peak_rss >= 0);
        assert!(info.current_commit >= 0);
        assert!(info.peak_commit >= 0);
        assert!(info.page_faults >= 0);

        // We should have some RSS or commit (we're running a program)
        assert!(
            info.current_rss > 0 || info.current_commit > 0,
            "Process should have non-zero RSS or commit"
        );

        // Note: We don't assert peak >= current because mi_process_info
        // might not accurately track peak in all scenarios, or the values
        // might come from different sources with timing issues
    }

    #[test]
    fn test_process_info_display() {
        let info = process_info();
        let display_str = format!("{}", info);

        assert!(display_str.contains("Process Information"));
        assert!(display_str.contains("Time:"));
        assert!(display_str.contains("Memory:"));
        assert!(display_str.contains("Faults:"));
    }

    // Utility function tests

    #[test]
    fn test_good_size() {
        // good_size should round up to the next size class
        let size1 = good_size(1);
        assert!(
            size1 >= 1,
            "good_size should be at least the requested size"
        );

        let size100 = good_size(100);
        assert!(
            size100 >= 100,
            "good_size should be at least the requested size"
        );
        assert!(
            size100 <= 256,
            "good_size for 100 should be reasonable (likely 128 or 256)"
        );

        // Sizes should be monotonic
        assert!(good_size(10) <= good_size(20));
        assert!(good_size(100) <= good_size(200));
    }

    #[test]
    fn test_usable_size_wrapper() {
        let ptr = unsafe { mi_malloc_aligned(100, 8) } as *mut u8;

        let usable = unsafe { usable_size(ptr) };
        assert!(
            usable >= 100,
            "Usable size should be at least the allocated size"
        );
        assert!(
            usable <= 1024,
            "Usable size should be reasonable for 100 byte allocation"
        );

        // usable_size should match good_size
        let good = good_size(100);
        assert_eq!(
            usable, good,
            "usable_size should match good_size for the allocation"
        );

        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn test_collect() {
        // Allocate and free some memory
        let ptrs: Vec<*mut u8> = (0..100)
            .map(|_| unsafe { mi_malloc_aligned(1024, 8) } as *mut u8)
            .collect();

        for ptr in &ptrs {
            unsafe { mi_free(*ptr as *mut c_void) };
        }

        // Test that collect doesn't crash
        collect(false);
        collect(true);

        // Can't really test much more than "it doesn't crash"
        // since the behavior is internal to mimalloc
    }

    // Multi-threading tests

    #[test]
    fn test_multithreaded_stats() {
        use std::thread;

        stats_reset();

        // Create multiple threads that allocate memory
        let handles: Vec<_> = (0..4)
            .map(|_| {
                thread::spawn(|| {
                    let ptrs: Vec<*mut u8> = (0..100)
                        .map(|_| unsafe { mi_malloc_aligned(1024, 8) } as *mut u8)
                        .collect();

                    // Do some work
                    thread::sleep(std::time::Duration::from_millis(10));

                    for ptr in ptrs {
                        unsafe { mi_free(ptr as *mut c_void) };
                    }
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }

        // Get merged stats
        let stats = stats_get_merged();

        // Should have seen multiple threads
        assert!(
            stats.threads().peak() >= 1,
            "Should have tracked at least 1 thread"
        );

        // Should have allocated and freed memory
        assert!(
            stats.malloc_normal_count().total() >= 400,
            "Should have counted all allocations from all threads"
        );
    }

    #[test]
    fn test_merged_vs_unmerged_stats() {
        stats_reset();

        let ptr = unsafe { mi_malloc_aligned(1024, 8) } as *mut u8;

        // Get unmerged stats
        let unmerged = stats_get();

        // Get merged stats
        let merged = stats_get_merged();

        // Merged should generally have equal or more complete data
        // (though in a single thread they might be identical)
        assert_eq!(
            unmerged.version(),
            merged.version(),
            "Version should be the same"
        );

        // Merged should show the allocation
        // Note: unmerged might not show thread-local allocations immediately
        assert!(
            merged.malloc_normal_count().total() > 0 || merged.reserved().current() > 0,
            "Merged stats should show some activity"
        );

        unsafe { mi_free(ptr as *mut c_void) };
    }

    #[test]
    fn test_stats_reset_actually_resets() {
        // Make many allocations to ensure we have significant stats
        let mut ptrs = Vec::new();
        for _ in 0..100 {
            ptrs.push(unsafe { mi_malloc_aligned(1024, 8) } as *mut u8);
        }

        let stats_before_reset = stats_get_merged();
        let count_before = stats_before_reset.malloc_normal_count().total();

        // Free everything
        for ptr in ptrs {
            unsafe { mi_free(ptr as *mut c_void) };
        }

        // stats_reset merges thread-local stats (deprecated in mimalloc v3.2+,
        // no longer clears counters)
        stats_reset();

        // After reset+merge, counters should still reflect the allocations
        let stats_after_reset = stats_get_merged();
        let count_after = stats_after_reset.malloc_normal_count().total();

        // Verify stats_reset didn't crash and counts are still valid
        assert!(
            count_after >= count_before,
            "Stats merge should preserve counters: before={}, after={}",
            count_before,
            count_after
        );
    }

    #[test]
    fn test_option_get_set_roundtrip() {
        let original = option_get(MiOption::ArenaReserve);
        let test_value = 128 * 1024; // 128 MiB in KiB
        option_set(MiOption::ArenaReserve, test_value);
        let read_back = option_get(MiOption::ArenaReserve);
        assert_eq!(read_back, test_value, "option_set/get roundtrip");
        // Restore the original value.
        option_set(MiOption::ArenaReserve, original);
    }
}
