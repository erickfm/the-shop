use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::error::{AppError, AppResult};

const HEADER_FST_OFFSET: u64 = 0x424;
const HEADER_FS_SIZE: u64 = 0x428;
const ENTRY_SIZE: u64 = 12;

#[derive(Debug, Clone)]
pub struct FstEntry {
    pub name: String,
    pub data_offset: u32,
    pub data_size: u32,
    pub entry_index: u32,
}

fn read_u32_be(f: &mut File, offset: u64) -> AppResult<u32> {
    let mut buf = [0u8; 4];
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| AppError::IsoRead(e.to_string()))?;
    f.read_exact(&mut buf)
        .map_err(|e| AppError::IsoRead(e.to_string()))?;
    Ok(u32::from_be_bytes(buf))
}

fn write_u32_be(f: &mut File, offset: u64, val: u32) -> AppResult<()> {
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| AppError::IsoWrite(e.to_string()))?;
    f.write_all(&val.to_be_bytes())
        .map_err(|e| AppError::IsoWrite(e.to_string()))?;
    Ok(())
}

pub fn list_root_files(iso: &Path) -> AppResult<HashMap<String, FstEntry>> {
    let mut f = File::open(iso).map_err(|e| AppError::IsoRead(e.to_string()))?;
    let fst_offset = read_u32_be(&mut f, HEADER_FST_OFFSET)? as u64;
    let _fs_size = read_u32_be(&mut f, HEADER_FS_SIZE)?;

    let entry_count = read_u32_be(&mut f, fst_offset + 8)?;
    let string_table_offset = fst_offset + (entry_count as u64) * ENTRY_SIZE;

    let mut out: HashMap<String, FstEntry> = HashMap::new();
    for i in 1..entry_count {
        let entry_off = fst_offset + (i as u64) * ENTRY_SIZE;
        let mut hdr = [0u8; 12];
        f.seek(SeekFrom::Start(entry_off))
            .map_err(|e| AppError::IsoRead(e.to_string()))?;
        f.read_exact(&mut hdr)
            .map_err(|e| AppError::IsoRead(e.to_string()))?;
        let is_dir = hdr[0] != 0;
        if is_dir {
            continue;
        }
        let mut name_off_buf = [0u8; 4];
        name_off_buf[1] = hdr[1];
        name_off_buf[2] = hdr[2];
        name_off_buf[3] = hdr[3];
        let name_offset = u32::from_be_bytes(name_off_buf) as u64;
        let data_offset = u32::from_be_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
        let data_size = u32::from_be_bytes([hdr[8], hdr[9], hdr[10], hdr[11]]);

        f.seek(SeekFrom::Start(string_table_offset + name_offset))
            .map_err(|e| AppError::IsoRead(e.to_string()))?;
        let mut name_bytes = Vec::with_capacity(32);
        let mut byte = [0u8; 1];
        loop {
            f.read_exact(&mut byte)
                .map_err(|e| AppError::IsoRead(e.to_string()))?;
            if byte[0] == 0 {
                break;
            }
            name_bytes.push(byte[0]);
            if name_bytes.len() > 256 {
                return Err(AppError::IsoRead("FST name too long".into()));
            }
        }
        let name = String::from_utf8_lossy(&name_bytes).into_owned();
        out.insert(
            name.clone(),
            FstEntry {
                name,
                data_offset,
                data_size,
                entry_index: i,
            },
        );
    }
    Ok(out)
}

pub fn read_file_bytes(iso: &Path, entry: &FstEntry) -> AppResult<Vec<u8>> {
    let mut f = File::open(iso).map_err(|e| AppError::IsoRead(e.to_string()))?;
    f.seek(SeekFrom::Start(entry.data_offset as u64))
        .map_err(|e| AppError::IsoRead(e.to_string()))?;
    let mut buf = vec![0u8; entry.data_size as usize];
    f.read_exact(&mut buf)
        .map_err(|e| AppError::IsoRead(e.to_string()))?;
    Ok(buf)
}

pub struct ReplaceOutcome {
    pub original_size: u32,
    pub new_size: u32,
    pub mode: ReplaceMode,
}

#[derive(Debug, serde::Serialize)]
pub enum ReplaceMode {
    InPlace,
    Appended { new_offset: u32 },
}

const FILE_ALIGNMENT: u64 = 32;

fn align_up(v: u64, a: u64) -> u64 {
    (v + a - 1) / a * a
}

pub fn replace_file_in_place(
    iso: &Path,
    fst_offset: u64,
    entry: &FstEntry,
    new_bytes: &[u8],
) -> AppResult<ReplaceOutcome> {
    let original_size = entry.data_size;
    let new_size = new_bytes.len() as u32;
    let mut f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(iso)
        .map_err(|e| AppError::IsoWrite(e.to_string()))?;
    let entry_off = fst_offset + (entry.entry_index as u64) * ENTRY_SIZE;

    if new_size <= original_size {
        f.seek(SeekFrom::Start(entry.data_offset as u64))
            .map_err(|e| AppError::IsoWrite(e.to_string()))?;
        f.write_all(new_bytes)
            .map_err(|e| AppError::IsoWrite(e.to_string()))?;
        if new_size < original_size {
            let pad = vec![0u8; (original_size - new_size) as usize];
            f.write_all(&pad)
                .map_err(|e| AppError::IsoWrite(e.to_string()))?;
        }
        write_u32_be(&mut f, entry_off + 8, new_size)?;
        f.sync_all().map_err(|e| AppError::IsoWrite(e.to_string()))?;
        return Ok(ReplaceOutcome {
            original_size,
            new_size,
            mode: ReplaceMode::InPlace,
        });
    }

    let eof = f
        .seek(SeekFrom::End(0))
        .map_err(|e| AppError::IsoWrite(e.to_string()))?;
    let new_offset_u64 = align_up(eof, FILE_ALIGNMENT);
    if new_offset_u64 > eof {
        let pad = vec![0u8; (new_offset_u64 - eof) as usize];
        f.seek(SeekFrom::Start(eof))
            .map_err(|e| AppError::IsoWrite(e.to_string()))?;
        f.write_all(&pad)
            .map_err(|e| AppError::IsoWrite(e.to_string()))?;
    }
    if new_offset_u64 > u32::MAX as u64 {
        return Err(AppError::IsoWrite(format!(
            "append offset {new_offset_u64} exceeds 32-bit FST range; ISO grew too large"
        )));
    }
    f.seek(SeekFrom::Start(new_offset_u64))
        .map_err(|e| AppError::IsoWrite(e.to_string()))?;
    f.write_all(new_bytes)
        .map_err(|e| AppError::IsoWrite(e.to_string()))?;

    write_u32_be(&mut f, entry_off + 4, new_offset_u64 as u32)?;
    write_u32_be(&mut f, entry_off + 8, new_size)?;
    f.sync_all().map_err(|e| AppError::IsoWrite(e.to_string()))?;

    Ok(ReplaceOutcome {
        original_size,
        new_size,
        mode: ReplaceMode::Appended {
            new_offset: new_offset_u64 as u32,
        },
    })
}

pub fn fst_offset_of(iso: &Path) -> AppResult<u64> {
    let mut f = File::open(iso).map_err(|e| AppError::IsoRead(e.to_string()))?;
    Ok(read_u32_be(&mut f, HEADER_FST_OFFSET)? as u64)
}
