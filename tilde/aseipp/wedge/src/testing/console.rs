// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A host for the console HAL, so the packages wlink links, the prototype
//! console game and PureDOOM, run whole under the reference interpreter.
//!
//! The linked module imports only `console:hal/raw@0.1.0`, the scalar
//! hardware abstraction layer of `tilde//aseipp/wlink/demo/sdk`, and
//! exports each import's canonical memory and allocator under
//! `wlink:import:<module>#<name>:memory` and `:realloc`. [`ConsoleHost`]
//! implements every HAL function the way the SDK's native hosts do, so a
//! run here can be compared with a run of the same module through wasm2c:
//! it keeps the trace lines the demo's stdio host prints, the frame hash
//! and headless clock of the SDK's runner, its virtual file root, and its
//! keyboard script.

use std::collections::{BTreeMap, VecDeque};

use wedge::interp::{Fault, Host, Instance, Value};
use wedge::ir::{ExportItem, FunctionId, Import, MemoryId, TrapCode};

const MAX_HANDLES: usize = 128;
/// `console:sdk/input.capability`: scripted releases, text, and mouse
/// reports are all real.
const KEY_RELEASES: u32 = 1;
const TEXT: u32 = 2;
const MOUSE: u32 = 4;
/// The HAL's audio: 44100 Hz stereo frames, a second of them queued at most.
const AUDIO_RATE: u64 = 44100;
const AUDIO_CHANNELS: usize = 2;
const AUDIO_CAPACITY: usize = 44100;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
const MAX_RAM_FILE: u64 = 64 * 1024 * 1024;

/// One keyboard transition, keyed by `console:sdk/input.key` ordinal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyEvent {
    pub key: u32,
    pub pressed: bool,
}

/// One line of the SDK host's input script.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScriptEvent {
    Key(KeyEvent),
    /// The pointer's position in frame pixels, the buttons held (the
    /// `mouse-buttons` bits), and the wheel notches turned that frame.
    Mouse {
        x: i32,
        y: i32,
        buttons: u32,
        wheel: i32,
    },
    Text(String),
}

/// The pointer as the guest reads it: motion and wheel notches accumulate
/// until `read-mouse`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MouseState {
    pub x: i32,
    pub y: i32,
    pub dx: i32,
    pub dy: i32,
    pub buttons: u32,
    pub wheel: i32,
    seen: bool,
}

/// The pixels the guest last presented.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Frame {
    /// The SDK host's checksum of the frame: FNV-1a over the pixel bytes.
    pub fn hash(&self) -> u64 {
        self.rgba.iter().fold(FNV_OFFSET, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME)
        })
    }
}

/// An entry of the virtual root. A free slot has an empty name; a file
/// removed while open keeps its slot, invisible, until its last handle
/// closes.
#[derive(Clone, Debug, Default)]
struct File {
    name: String,
    data: Vec<u8>,
    readonly: bool,
    directory: bool,
    removed: bool,
    open_count: u32,
}

#[derive(Clone, Copy, Debug)]
struct Handle {
    file: usize,
    writable: bool,
}

/// The console's hardware: what the HAL imports read and write.
#[derive(Debug, Default)]
pub struct ConsoleHost {
    /// What `now-ms` reports.
    pub now_ms: u64,
    /// What `frames-per-second` reports; `set-frame-rate` changes it before
    /// the first frame.
    pub frames_per_second: u64,
    /// Frames started, so `set-frame-rate` knows whether one has.
    pub frames: u64,
    /// What `unix-seconds` and `random-seed` report.
    pub unix_seconds: i64,
    pub random_seed: u64,
    /// Events the next `read-events` call delivers.
    pub events: Vec<KeyEvent>,
    pub mouse: MouseState,
    /// Text the next `read-text` call delivers.
    pub text: String,
    /// The guest's arguments, the program name first.
    pub args: Vec<String>,
    files: Vec<File>,
    handles: Vec<Option<Handle>>,
    /// The last presented frame.
    pub frame: Option<Frame>,
    pub presentations: u64,
    /// Queued audio frames, interleaved, and the SDK host's running FNV-1a
    /// hash of every sample played, with how many frames were played.
    audio: VecDeque<i16>,
    pub audio_hash: u64,
    pub audio_played: u64,
    audio_head: u64,
    /// Every log message, with its level.
    pub logs: Vec<(u32, String)>,
    /// Every HAL call, one line each, in the form the demo's stdio host
    /// prints.
    pub trace: Vec<String>,
    /// The code the guest asked to exit with.
    pub exit: Option<i32>,
    /// Each import's memory and allocator, resolved once.
    bindings: BTreeMap<String, (Option<MemoryId>, Option<FunctionId>)>,
}

impl ConsoleHost {
    pub fn new() -> Self {
        Self {
            audio_hash: FNV_OFFSET,
            frames_per_second: 60,
            ..Self::default()
        }
    }

    /// Moves the pointer to `x`, `y` in frame pixels with `buttons` held
    /// and `wheel` notches turned, as a script's mouse line does.
    pub fn move_mouse(&mut self, x: i32, y: i32, buttons: u32, wheel: i32) {
        if self.mouse.seen {
            self.mouse.dx += x - self.mouse.x;
            self.mouse.dy += y - self.mouse.y;
        }
        self.mouse.seen = true;
        self.mouse.x = x;
        self.mouse.y = y;
        self.mouse.buttons = buttons;
        self.mouse.wheel += wheel;
    }

    /// Plays what the frame period since the last call covers, as the SDK
    /// host does after every frame: queued frames go through the hash, the
    /// rest of the period is silence.
    pub fn play_audio(&mut self, frames: u64, frames_per_second: u64) {
        let target = frames * AUDIO_RATE / frames_per_second;
        let due = target - self.audio_head;
        self.audio_head = target;
        let played = (self.audio.len() / AUDIO_CHANNELS).min(due as usize);
        for sample in self.audio.drain(..played * AUDIO_CHANNELS) {
            for byte in sample.to_le_bytes() {
                self.audio_hash = (self.audio_hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME);
            }
        }
        self.audio_played += played as u64;
    }

    /// Mounts `data` read-only as `path` in the virtual root, as the SDK
    /// host mounts a game's assets.
    pub fn mount_readonly(&mut self, path: &str, data: Vec<u8>) -> Result<(), String> {
        let name =
            file_name(path.as_bytes()).ok_or_else(|| format!("{path:?} is not a file name"))?;
        if self.find(&name).is_some() {
            return Err(format!("{name:?} is already mounted"));
        }
        if !self.ensure_parents(&name) {
            return Err(format!("a file is in the way of {name:?}"));
        }
        let index = self.add(&name, false);
        self.files[index].data = data;
        self.files[index].readonly = true;
        Ok(())
    }

    /// The bytes of the file `name` in the virtual root, if the guest
    /// created or wrote one.
    pub fn file(&self, name: &str) -> Option<&[u8]> {
        self.find(name)
            .map(|index| self.files[index].data.as_slice())
    }

    fn find(&self, name: &str) -> Option<usize> {
        self.files
            .iter()
            .position(|file| !file.name.is_empty() && !file.removed && file.name == name)
    }

    fn add(&mut self, name: &str, directory: bool) -> usize {
        let file = File {
            name: name.to_owned(),
            directory,
            ..File::default()
        };
        match self.files.iter().position(|slot| slot.name.is_empty()) {
            Some(index) => {
                self.files[index] = file;
                index
            }
            None => {
                self.files.push(file);
                self.files.len() - 1
            }
        }
    }

    /// Every directory on a name's path exists, created as needed; a file
    /// in the way fails.
    fn ensure_parents(&mut self, name: &str) -> bool {
        for (index, _) in name.match_indices('/') {
            let parent = &name[..index];
            match self.find(parent) {
                Some(existing) if !self.files[existing].directory => return false,
                Some(_) => {}
                None => {
                    self.add(parent, true);
                }
            }
        }
        true
    }

    fn child_of(file: &File, dir: &str) -> bool {
        if file.name.is_empty() || file.removed {
            return false;
        }
        let rest = if dir.is_empty() {
            file.name.as_str()
        } else {
            match file
                .name
                .strip_prefix(dir)
                .and_then(|rest| rest.strip_prefix('/'))
            {
                Some(rest) => rest,
                None => return false,
            }
        };
        !rest.contains('/')
    }

    /// The entries directly inside `dir`, sorted by name.
    fn children(&self, dir: &str) -> Vec<usize> {
        let mut children: Vec<usize> = (0..self.files.len())
            .filter(|index| Self::child_of(&self.files[*index], dir))
            .collect();
        children.sort_by(|a, b| self.files[*a].name.cmp(&self.files[*b].name));
        children
    }

    fn release(&mut self, index: usize) {
        self.files[index] = File::default();
    }

    fn close(&mut self, fd: u32) {
        let Some(handle) = self.handles.get_mut(fd as usize).and_then(Option::take) else {
            return;
        };
        let file = &mut self.files[handle.file];
        file.open_count -= 1;
        if file.removed && file.open_count == 0 {
            self.release(handle.file);
        }
    }

    fn remove(&mut self, name: &str) -> i32 {
        let Some(index) = self.find(name) else {
            return -1;
        };
        let file = &self.files[index];
        if file.readonly
            || (file.directory && self.files.iter().any(|entry| Self::child_of(entry, name)))
        {
            return -1;
        }
        if self.files[index].open_count > 0 {
            self.files[index].removed = true;
        } else {
            self.release(index);
        }
        0
    }

    fn rename(&mut self, from: &str, to: &str) -> i32 {
        let Some(index) = self.find(from) else {
            return -1;
        };
        if self.files[index].readonly {
            return -1;
        }
        if from == to {
            return 0;
        }
        let directory = self.files[index].directory;
        let prefix = format!("{from}/");
        let below = |file: &File| !file.name.is_empty() && file.name.starts_with(&prefix);
        // The new name may not lie inside the old one, and every entry below
        // must still fit.
        if directory
            && (to.starts_with(&prefix)
                || self
                    .files
                    .iter()
                    .any(|file| below(file) && file.name.len() - from.len() + to.len() >= 256))
        {
            return -1;
        }
        if let Some(target) = self.find(to) {
            let target = &self.files[target];
            if target.directory || target.readonly || directory {
                return -1;
            }
        }
        if !self.ensure_parents(to) {
            return -1;
        }
        if let Some(target) = self.find(to) {
            if self.files[target].open_count > 0 {
                self.files[target].removed = true;
            } else {
                self.release(target);
            }
        }
        if directory {
            for file in &mut self.files {
                if !file.removed && below(file) {
                    file.name = format!("{to}{}", &file.name[from.len()..]);
                }
            }
        }
        self.files[index].name = to.to_owned();
        0
    }

    fn create_directory(&mut self, name: &str) -> i32 {
        if name.is_empty() {
            return 0;
        }
        match self.find(name) {
            Some(index) => {
                if self.files[index].directory {
                    0
                } else {
                    -1
                }
            }
            None if self.ensure_parents(name) => {
                self.add(name, true);
                0
            }
            None => -1,
        }
    }

    /// The memory and allocator the module exports for `import`; an
    /// import without pointer arguments or results exports neither.
    fn binding(
        &mut self,
        instance: &Instance<'_>,
        import: &Import,
    ) -> (Option<MemoryId>, Option<FunctionId>) {
        if let Some(binding) = self.bindings.get(&import.name) {
            return *binding;
        }
        let prefix = format!("wlink:import:{}#{}", import.module, import.name);
        let memory = match instance.export(&format!("{prefix}:memory")) {
            Some(ExportItem::Memory(memory)) => Some(memory),
            _ => None,
        };
        let realloc = match instance.export(&format!("{prefix}:realloc")) {
            Some(ExportItem::Function(function)) => Some(function),
            _ => None,
        };
        self.bindings.insert(import.name.clone(), (memory, realloc));
        (memory, realloc)
    }

    /// The `len` bytes at `ptr` of `memory`, or the trap the wasm2c hosts
    /// raise for a range outside it.
    fn bytes<'a>(
        instance: &'a Instance<'_>,
        memory: MemoryId,
        ptr: u32,
        len: u32,
    ) -> Result<&'a [u8], Fault> {
        instance
            .store()
            .memories
            .get(memory.index())
            .and_then(|memory| memory.slice(u64::from(ptr), len as usize))
            .ok_or(Fault::Trap(TrapCode::MemoryOutOfBounds))
    }

    fn bytes_mut<'a>(
        instance: &'a mut Instance<'_>,
        memory: MemoryId,
        ptr: u32,
        len: u32,
    ) -> Result<&'a mut [u8], Fault> {
        instance
            .store_mut()
            .memories
            .get_mut(memory.index())
            .and_then(|memory| memory.slice_mut(u64::from(ptr), len as usize))
            .ok_or(Fault::Trap(TrapCode::MemoryOutOfBounds))
    }

    fn store32(
        instance: &mut Instance<'_>,
        memory: MemoryId,
        ptr: u32,
        value: u32,
    ) -> Result<(), Fault> {
        Self::bytes_mut(instance, memory, ptr, 4)?.copy_from_slice(&value.to_le_bytes());
        Ok(())
    }

    /// A fresh allocation of `len` bytes through the guest's own
    /// allocator, or the aligned dangling pointer the generated bindings
    /// expect for an empty one.
    fn allocate(
        &mut self,
        instance: &mut Instance<'_>,
        realloc: Option<FunctionId>,
        align: u32,
        len: u32,
    ) -> Result<u32, Fault> {
        if len == 0 {
            return Ok(align);
        }
        let realloc = realloc.ok_or_else(|| {
            Fault::Unsupported("the import has no realloc to allocate its result with".to_owned())
        })?;
        let results = instance.call(
            self,
            realloc,
            &[
                Value::I32(0),
                Value::I32(0),
                Value::I32(align),
                Value::I32(len),
            ],
        )?;
        match results.as_slice() {
            [Value::I32(ptr)] => Ok(*ptr),
            other => Err(Fault::Invalid(format!("realloc returned {other:?}"))),
        }
    }

    fn open(&mut self, name: String, write: bool) -> i32 {
        if self.handles.len() < MAX_HANDLES {
            self.handles.resize(MAX_HANDLES, None);
        }
        let Some(fd) = self.handles.iter().position(Option::is_none) else {
            return -1;
        };
        let mut file = self.find(&name);
        if file.is_none() && write && self.ensure_parents(&name) {
            file = Some(self.add(&name, false));
        }
        let Some(file) = file else {
            return -1;
        };
        if self.files[file].directory || (write && self.files[file].readonly) {
            return -1;
        }
        if write {
            self.files[file].data.clear();
        }
        self.files[file].open_count += 1;
        self.handles[fd] = Some(Handle {
            file,
            writable: write,
        });
        fd as i32
    }

    fn handle(&self, fd: u32) -> Option<Handle> {
        self.handles.get(fd as usize).copied().flatten()
    }
}

/// A path in the virtual root, as the SDK host reads one: leading `./`
/// stripped, slash-separated segments none of which is empty, `.`, or
/// `..`, and shorter than 256 bytes.
fn file_name(mut path: &[u8]) -> Option<String> {
    while path.len() >= 2 && path[0] == b'.' && path[1] == b'/' {
        path = &path[2..];
    }
    if path.is_empty()
        || path.len() >= 256
        || path.iter().any(|byte| matches!(byte, 0 | b'\\'))
        || path
            .split(|byte| *byte == b'/')
            .any(|segment| segment.is_empty() || segment == b"." || segment == b"..")
    {
        return None;
    }
    Some(String::from_utf8_lossy(path).into_owned())
}

/// A directory is named like a file, except that the root is the empty
/// path or `.`, named by the empty string.
fn directory_name(mut path: &[u8]) -> Option<String> {
    while path.len() >= 2 && path[0] == b'.' && path[1] == b'/' {
        path = &path[2..];
    }
    if path.is_empty() || path == b"." {
        return Some(String::new());
    }
    file_name(path)
}

fn i32_argument(arguments: &[Value], index: usize) -> Result<u32, Fault> {
    match arguments.get(index) {
        Some(Value::I32(value)) => Ok(*value),
        other => Err(Fault::Invalid(format!(
            "argument {index} is {other:?}, not an i32"
        ))),
    }
}

fn i64_argument(arguments: &[Value], index: usize) -> Result<u64, Fault> {
    match arguments.get(index) {
        Some(Value::I64(value)) => Ok(*value),
        other => Err(Fault::Invalid(format!(
            "argument {index} is {other:?}, not an i64"
        ))),
    }
}

impl Host for ConsoleHost {
    fn call(
        &mut self,
        instance: &mut Instance<'_>,
        import: &Import,
        arguments: &[Value],
    ) -> Result<Vec<Value>, Fault> {
        if !import.module.starts_with("console:hal/raw@") {
            return Err(Fault::Unsupported(format!(
                "import {:?}.{:?} is not part of the console HAL",
                import.module, import.name
            )));
        }
        let (memory, realloc) = self.binding(instance, import);
        let memory = memory.ok_or_else(|| {
            Fault::Unsupported(format!(
                "the module does not export a memory for {:?}.{:?}",
                import.module, import.name
            ))
        });
        let i32s = |index| i32_argument(arguments, index);
        let none = Vec::new();
        Ok(match import.name.as_str() {
            "write-log" => {
                let memory = memory?;
                let level = i32s(0)?;
                let message = Self::bytes(instance, memory, i32s(1)?, i32s(2)?)?;
                let message = String::from_utf8_lossy(message).into_owned();
                self.trace.push(format!("[hal] log {level}: {message}"));
                self.logs.push((level, message));
                none
            }
            "present" => {
                let memory = memory?;
                let (width, height, ptr, len) = (i32s(0)?, i32s(1)?, i32s(2)?, i32s(3)?);
                if width == 0
                    || height == 0
                    || u64::from(width) * u64::from(height) * 4 != u64::from(len)
                {
                    return Err(Fault::Trap(TrapCode::MemoryOutOfBounds));
                }
                let rgba = Self::bytes(instance, memory, ptr, len)?.to_vec();
                self.frame = Some(Frame {
                    width,
                    height,
                    rgba,
                });
                self.presentations += 1;
                self.trace
                    .push(format!("[hal] present {width} {height} bytes={len}"));
                none
            }
            "present-indexed" => {
                let memory = memory?;
                let (width, height, ptr, len, palette_ptr, palette_len) =
                    (i32s(0)?, i32s(1)?, i32s(2)?, i32s(3)?, i32s(4)?, i32s(5)?);
                if width == 0
                    || height == 0
                    || u64::from(width) * u64::from(height) != u64::from(len)
                    || palette_len != 256
                {
                    return Err(Fault::Trap(TrapCode::MemoryOutOfBounds));
                }
                let indexed = Self::bytes(instance, memory, ptr, len)?.to_vec();
                let palette = Self::bytes(instance, memory, palette_ptr, palette_len * 4)?.to_vec();
                let mut rgba = Vec::with_capacity(indexed.len() * 4);
                for index in indexed {
                    rgba.extend_from_slice(&palette[index as usize * 4..index as usize * 4 + 4]);
                }
                self.frame = Some(Frame {
                    width,
                    height,
                    rgba,
                });
                self.presentations += 1;
                self.trace.push(format!(
                    "[hal] present-indexed {width} {height} bytes={len}"
                ));
                none
            }
            "frames-per-second" => vec![Value::I32(self.frames_per_second as u32)],
            "set-frame-rate" => {
                let hz = i32s(0)?;
                if self.frames == 0 && (1..=1000).contains(&hz) {
                    self.frames_per_second = u64::from(hz);
                }
                vec![Value::I32(self.frames_per_second as u32)]
            }
            "unix-seconds" => vec![Value::I64(self.unix_seconds as u64)],
            "random-seed" => vec![Value::I64(self.random_seed)],
            "host-name" => {
                let memory = memory?;
                let result = i32s(0)?;
                let name = "interpreter";
                let ptr = self.allocate(instance, realloc, 1, name.len() as u32)?;
                Self::bytes_mut(instance, memory, ptr, name.len() as u32)?
                    .copy_from_slice(name.as_bytes());
                Self::store32(instance, memory, result, ptr)?;
                Self::store32(instance, memory, result + 4, name.len() as u32)?;
                none
            }
            "host-features" => vec![Value::I32(0)],
            "set-title" => {
                let memory = memory?;
                let title = Self::bytes(instance, memory, i32s(0)?, i32s(1)?)?;
                let title = String::from_utf8_lossy(title).into_owned();
                self.trace.push(format!("[hal] set-title \"{title}\""));
                none
            }
            "read-events" => {
                let memory = memory?;
                let result = i32s(0)?;
                let events = std::mem::take(&mut self.events);
                let count = events.len() as u32;
                let ptr = self.allocate(instance, realloc, 4, count * 8)?;
                for (index, event) in events.iter().enumerate() {
                    let at = ptr + 8 * index as u32;
                    let bytes = Self::bytes_mut(instance, memory, at, 8)?;
                    bytes[..4].copy_from_slice(&event.key.to_le_bytes());
                    bytes[4] = u8::from(event.pressed);
                    bytes[5..].fill(0);
                }
                Self::store32(instance, memory, result, ptr)?;
                Self::store32(instance, memory, result + 4, count)?;
                none
            }
            "input-capabilities" => vec![Value::I32(KEY_RELEASES | TEXT | MOUSE)],
            "read-mouse" => {
                let memory = memory?;
                let result = i32s(0)?;
                let mouse = self.mouse;
                let fields = [
                    mouse.x,
                    mouse.y,
                    mouse.dx,
                    mouse.dy,
                    mouse.buttons as i32,
                    mouse.wheel,
                ];
                for (index, field) in fields.into_iter().enumerate() {
                    Self::store32(instance, memory, result + 4 * index as u32, field as u32)?;
                }
                self.mouse.dx = 0;
                self.mouse.dy = 0;
                self.mouse.wheel = 0;
                none
            }
            "capture-pointer" => vec![Value::I32(0)],
            "read-text" => {
                let memory = memory?;
                let result = i32s(0)?;
                let text = std::mem::take(&mut self.text);
                let ptr = self.allocate(instance, realloc, 1, text.len() as u32)?;
                if !text.is_empty() {
                    Self::bytes_mut(instance, memory, ptr, text.len() as u32)?
                        .copy_from_slice(text.as_bytes());
                }
                Self::store32(instance, memory, result, ptr)?;
                Self::store32(instance, memory, result + 4, text.len() as u32)?;
                none
            }
            "audio-write" => {
                let memory = memory?;
                let (ptr, len) = (i32s(0)?, i32s(1)?);
                let bytes = Self::bytes(instance, memory, ptr, len * 2)?;
                let room = AUDIO_CAPACITY - self.audio.len() / AUDIO_CHANNELS;
                let frames = (len as usize / AUDIO_CHANNELS).min(room);
                self.audio.extend(
                    bytes[..frames * AUDIO_CHANNELS * 2]
                        .chunks_exact(2)
                        .map(|pair| i16::from_le_bytes([pair[0], pair[1]])),
                );
                vec![Value::I32(frames as u32)]
            }
            "audio-queued" => vec![Value::I32((self.audio.len() / AUDIO_CHANNELS) as u32)],
            "now-ms" => vec![Value::I64(self.now_ms)],
            "file-open" => {
                let memory = memory?;
                let (ptr, len, write) = (i32s(0)?, i32s(1)?, i32s(2)?);
                let name = file_name(Self::bytes(instance, memory, ptr, len)?);
                let fd = match name {
                    Some(name) => self.open(name, write != 0),
                    None => -1,
                };
                vec![Value::I32(fd as u32)]
            }
            "file-size" => {
                let size = self
                    .handle(i32s(0)?)
                    .map_or(u64::MAX, |handle| self.files[handle.file].data.len() as u64);
                vec![Value::I64(size)]
            }
            "file-read-at" => {
                let memory = memory?;
                let (fd, offset, length, result) =
                    (i32s(0)?, i64_argument(arguments, 1)?, i32s(2)?, i32s(3)?);
                let handle = self.handle(fd);
                let chunk: Vec<u8> = match handle {
                    Some(handle) => {
                        let data = &self.files[handle.file].data;
                        if offset < data.len() as u64 {
                            let start = offset as usize;
                            let end = start + (data.len() - start).min(length as usize);
                            data[start..end].to_vec()
                        } else {
                            Vec::new()
                        }
                    }
                    None => Vec::new(),
                };
                let ptr = self.allocate(instance, realloc, 1, chunk.len() as u32)?;
                if !chunk.is_empty() {
                    Self::bytes_mut(instance, memory, ptr, chunk.len() as u32)?
                        .copy_from_slice(&chunk);
                }
                Self::store32(
                    instance,
                    memory,
                    result,
                    if handle.is_some() { 0 } else { u32::MAX },
                )?;
                Self::store32(instance, memory, result + 4, ptr)?;
                Self::store32(instance, memory, result + 8, chunk.len() as u32)?;
                none
            }
            "file-write-at" => {
                let memory = memory?;
                let (fd, offset, ptr, len) =
                    (i32s(0)?, i64_argument(arguments, 1)?, i32s(2)?, i32s(3)?);
                let Some(handle) = self.handle(fd).filter(|handle| handle.writable) else {
                    return Ok(vec![Value::I32(u32::MAX)]);
                };
                if offset > MAX_RAM_FILE || u64::from(len) > MAX_RAM_FILE - offset {
                    return Ok(vec![Value::I32(u32::MAX)]);
                }
                let data = Self::bytes(instance, memory, ptr, len)?.to_vec();
                let file = &mut self.files[handle.file].data;
                let end = (offset + u64::from(len)) as usize;
                if len != 0 && end > file.len() {
                    file.resize(end, 0);
                }
                if len != 0 {
                    file[offset as usize..end].copy_from_slice(&data);
                }
                vec![Value::I32(len)]
            }
            "file-close" => {
                self.close(i32s(0)?);
                none
            }
            "file-list-directory" => {
                let memory = memory?;
                let (ptr, len, result) = (i32s(0)?, i32s(1)?, i32s(2)?);
                let name = directory_name(Self::bytes(instance, memory, ptr, len)?);
                let listing: Option<Vec<(String, u64, bool)>> = name.and_then(|name| {
                    let found = name.is_empty()
                        || self
                            .find(&name)
                            .is_some_and(|index| self.files[index].directory);
                    let skip = if name.is_empty() { 0 } else { name.len() + 1 };
                    found.then(|| {
                        self.children(&name)
                            .into_iter()
                            .map(|index| {
                                let file = &self.files[index];
                                let size = if file.directory {
                                    0
                                } else {
                                    file.data.len() as u64
                                };
                                (file.name[skip..].to_owned(), size, file.directory)
                            })
                            .collect()
                    })
                });
                let entries = listing.as_deref().unwrap_or(&[]);
                let count = entries.len() as u32;
                // The entry record is a string, a u64, and a bool: 24 bytes,
                // 8-aligned.
                let list = self.allocate(instance, realloc, 8, count * 24)?;
                if count > 0 {
                    Self::bytes_mut(instance, memory, list, count * 24)?.fill(0);
                }
                for (index, (child, size, directory)) in entries.iter().enumerate() {
                    let text = self.allocate(instance, realloc, 1, child.len() as u32)?;
                    if !child.is_empty() {
                        Self::bytes_mut(instance, memory, text, child.len() as u32)?
                            .copy_from_slice(child.as_bytes());
                    }
                    let at = list + 24 * index as u32;
                    let bytes = Self::bytes_mut(instance, memory, at, 24)?;
                    bytes[..4].copy_from_slice(&text.to_le_bytes());
                    bytes[4..8].copy_from_slice(&(child.len() as u32).to_le_bytes());
                    bytes[8..16].copy_from_slice(&size.to_le_bytes());
                    bytes[16] = u8::from(*directory);
                }
                Self::store32(
                    instance,
                    memory,
                    result,
                    if listing.is_some() { 0 } else { u32::MAX },
                )?;
                Self::store32(instance, memory, result + 4, list)?;
                Self::store32(instance, memory, result + 8, count)?;
                none
            }
            "file-remove" => {
                let memory = memory?;
                let name = file_name(Self::bytes(instance, memory, i32s(0)?, i32s(1)?)?);
                let status = name.map_or(-1, |name| self.remove(&name));
                vec![Value::I32(status as u32)]
            }
            "file-rename" => {
                let memory = memory?;
                let from = file_name(Self::bytes(instance, memory, i32s(0)?, i32s(1)?)?);
                let to = file_name(Self::bytes(instance, memory, i32s(2)?, i32s(3)?)?);
                let status = match (from, to) {
                    (Some(from), Some(to)) => self.rename(&from, &to),
                    _ => -1,
                };
                vec![Value::I32(status as u32)]
            }
            "file-create-directory" => {
                let memory = memory?;
                let name = directory_name(Self::bytes(instance, memory, i32s(0)?, i32s(1)?)?);
                let status = name.map_or(-1, |name| self.create_directory(&name));
                vec![Value::I32(status as u32)]
            }
            "arg-count" => vec![Value::I32(self.args.len() as u32)],
            "arg" => {
                let memory = memory?;
                let (index, result) = (i32s(0)?, i32s(1)?);
                let text = self.args.get(index as usize).cloned().unwrap_or_default();
                let ptr = self.allocate(instance, realloc, 1, text.len() as u32)?;
                if !text.is_empty() {
                    Self::bytes_mut(instance, memory, ptr, text.len() as u32)?
                        .copy_from_slice(text.as_bytes());
                }
                Self::store32(instance, memory, result, ptr)?;
                Self::store32(instance, memory, result + 4, text.len() as u32)?;
                none
            }
            "exit" => {
                self.exit = Some(i32s(0)? as i32);
                return Err(Fault::Trap(TrapCode::Unreachable));
            }
            other => {
                return Err(Fault::Unsupported(format!("HAL function {other:?}")));
            }
        })
    }
}

/// A headless run of a linked console package, paced the way the SDK's
/// native host paces one: a synthetic clock advancing a frame's worth of
/// milliseconds per frame, keyboard events from a script, and the frame
/// hash the host's `--trace` prints after every frame.
pub struct Console<'program> {
    pub host: ConsoleHost,
    pub instance: Instance<'program>,
    frames_per_second: u64,
    frames: u64,
    /// Scripted events, sorted by the frame before which they arrive.
    script: Vec<(u64, ScriptEvent)>,
    next_scripted: usize,
}

/// One frame's observable outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameTrace {
    pub frame: u64,
    pub hash: u64,
    pub game_memory: u64,
    pub platform_memory: u64,
    pub audio: u64,
    pub played: u64,
}

impl std::fmt::Display for FrameTrace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "frame={} hash={:016x} game-memory={} platform-memory={} audio={:016x} played={}",
            self.frame, self.hash, self.game_memory, self.platform_memory, self.audio, self.played
        )
    }
}

impl<'program> Console<'program> {
    /// Instantiates `program` against `host` and runs the package's
    /// `init`, with the events scripted before the first frame already
    /// queued.
    pub fn start(
        program: &'program wedge::ir::Program,
        mut host: ConsoleHost,
        config: wedge::interp::Config,
        frames_per_second: u64,
        script: Vec<(u64, ScriptEvent)>,
    ) -> Result<Self, Fault> {
        host.frames_per_second = frames_per_second;
        let instance = Instance::instantiate(program, &mut host, config)?;
        let mut console = Self {
            host,
            instance,
            frames_per_second,
            frames: 0,
            script,
            next_scripted: 0,
        };
        console.queue_input();
        console
            .instance
            .invoke_export(&mut console.host, "init", &[])?;
        Ok(console)
    }

    fn queue_input(&mut self) {
        while let Some((frame, event)) = self.script.get(self.next_scripted) {
            if *frame > self.frames {
                break;
            }
            match event {
                ScriptEvent::Key(key) => self.host.events.push(*key),
                ScriptEvent::Mouse {
                    x,
                    y,
                    buttons,
                    wheel,
                } => self.host.move_mouse(*x, *y, *buttons, *wheel),
                ScriptEvent::Text(text) => self.host.text.push_str(text),
            }
            self.next_scripted += 1;
        }
    }

    /// Runs one frame: advances the clock, delivers the frame's scripted
    /// events, calls the package's `frame`, and lets the platform end the
    /// frame. `Ok(false)` means the game asked to stop.
    pub fn frame(&mut self) -> Result<bool, Fault> {
        // The rate the host reports may have been set during init.
        self.frames_per_second = self.host.frames_per_second;
        let next_ms =
            ((self.frames + 1) * 1000 + self.frames_per_second - 1) / self.frames_per_second;
        let dt = next_ms - self.host.now_ms;
        self.host.now_ms = next_ms;
        self.frames += 1;
        self.host.frames = self.frames;
        self.queue_input();
        let results =
            self.instance
                .invoke_export(&mut self.host, "frame", &[Value::I32(dt as u32)])?;
        self.instance
            .invoke_export(&mut self.host, "end-frame", &[])?;
        self.host.play_audio(self.frames, self.frames_per_second);
        match results.as_slice() {
            [Value::I32(more)] => Ok(*more != 0),
            other => Err(Fault::Invalid(format!("frame returned {other:?}"))),
        }
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// What the SDK host's `--trace` line reports after the last frame.
    pub fn trace(&self) -> FrameTrace {
        let memory_size = |name: &str| match self.instance.export(name) {
            Some(ExportItem::Memory(memory)) => self
                .instance
                .store()
                .memories
                .get(memory.index())
                .map_or(0, |memory| memory.bytes.len() as u64),
            _ => 0,
        };
        FrameTrace {
            frame: self.frames,
            hash: self
                .host
                .frame
                .as_ref()
                .map_or(Frame::default().hash(), Frame::hash),
            game_memory: memory_size("game:memory"),
            platform_memory: memory_size("platform:memory"),
            audio: self.host.audio_hash,
            played: self.host.audio_played,
        }
    }
}

/// The SDK host's input script: sorted `frame key down|up`, `frame mouse x
/// y buttons wheel`, and `frame text ...` lines, with the key names its
/// `--script` option accepts.
pub fn parse_script(text: &str) -> Result<Vec<(u64, ScriptEvent)>, String> {
    let mut script: Vec<(u64, ScriptEvent)> = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.splitn(3, char::is_whitespace).collect();
        let [frame, kind, rest] = fields.as_slice() else {
            return Err(format!("expected 'frame key down|up', found {line:?}"));
        };
        let frame: u64 = frame
            .parse()
            .map_err(|_| format!("bad frame number in {line:?}"))?;
        let event = match *kind {
            "mouse" => {
                let numbers: Vec<&str> = rest.split_whitespace().collect();
                let [x, y, buttons, wheel] = numbers.as_slice() else {
                    return Err(format!(
                        "expected 'frame mouse x y buttons wheel', found {line:?}"
                    ));
                };
                let number = |field: &str| {
                    field
                        .parse::<i32>()
                        .map_err(|_| format!("bad number in {line:?}"))
                };
                let buttons: u32 = buttons
                    .parse()
                    .ok()
                    .filter(|buttons| *buttons <= 7)
                    .ok_or_else(|| format!("bad buttons in {line:?}"))?;
                ScriptEvent::Mouse {
                    x: number(x)?,
                    y: number(y)?,
                    buttons,
                    wheel: number(wheel)?,
                }
            }
            "text" => {
                let text = rest.trim_end_matches(['\r', '\n']);
                if text.is_empty() {
                    return Err(format!("expected 'frame text ...', found {line:?}"));
                }
                ScriptEvent::Text(text.to_owned())
            }
            key => {
                let key = key_code(key).ok_or_else(|| format!("unknown key in {line:?}"))?;
                let pressed = match rest.trim() {
                    "down" => true,
                    "up" => false,
                    _ => return Err(format!("expected down or up in {line:?}")),
                };
                ScriptEvent::Key(KeyEvent { key, pressed })
            }
        };
        if script.last().is_some_and(|(last, _)| *last > frame) {
            return Err(format!("{line:?} is out of order"));
        }
        script.push((frame, event));
    }
    Ok(script)
}

/// The `console:sdk/input.key` ordinal of a scripted key name: the named
/// keys come first in the SDK's enum, then `f1`..`f12`, `a`..`z`, the
/// digits `0`..`9`, the punctuation keys by name, `pause`, and the
/// navigation and keypad keys by name.
fn key_code(name: &str) -> Option<u32> {
    const NAMES: [&str; 12] = [
        "tab",
        "enter",
        "escape",
        "space",
        "backspace",
        "up",
        "down",
        "left",
        "right",
        "shift",
        "control",
        "alt",
    ];
    const PUNCTUATION: [&str; 11] = [
        "minus",
        "equals",
        "comma",
        "period",
        "slash",
        "semicolon",
        "apostrophe",
        "left-bracket",
        "right-bracket",
        "backslash",
        "grave",
    ];
    const EXTRA: [&str; 23] = [
        "insert",
        "delete",
        "home",
        "end",
        "page-up",
        "page-down",
        "caps-lock",
        "kp0",
        "kp1",
        "kp2",
        "kp3",
        "kp4",
        "kp5",
        "kp6",
        "kp7",
        "kp8",
        "kp9",
        "kp-enter",
        "kp-period",
        "kp-plus",
        "kp-minus",
        "kp-multiply",
        "kp-divide",
    ];
    const F1: u32 = NAMES.len() as u32;
    const A: u32 = F1 + 12;
    const NUM0: u32 = A + 26;
    const MINUS: u32 = NUM0 + 10;
    const PAUSE: u32 = MINUS + PUNCTUATION.len() as u32;
    const INSERT: u32 = PAUSE + 1;
    if let Some(position) = NAMES.iter().position(|candidate| *candidate == name) {
        return Some(position as u32);
    }
    if let Some(position) = PUNCTUATION.iter().position(|candidate| *candidate == name) {
        return Some(MINUS + position as u32);
    }
    if let Some(position) = EXTRA.iter().position(|candidate| *candidate == name) {
        return Some(INSERT + position as u32);
    }
    let mut characters = name.chars();
    match (characters.next(), characters.next()) {
        (Some(letter @ 'a'..='z'), None) => return Some(A + (letter as u32 - 'a' as u32)),
        (Some(digit @ '0'..='9'), None) => return Some(NUM0 + (digit as u32 - '0' as u32)),
        _ => {}
    }
    if name == "pause" {
        return Some(PAUSE);
    }
    if let Some(number) = name.strip_prefix('f') {
        if let Ok(number @ 1..=12) = number.parse::<u32>() {
            return Some(F1 + number - 1);
        }
    }
    None
}
