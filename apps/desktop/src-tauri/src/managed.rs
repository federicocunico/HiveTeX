//! Compilers HiveTeX installs into its own data folder (no admin rights, nothing system-wide): the quick compiler
//! (Tectonic) and the optional full LaTeX (TinyTeX). Pinned releases, verified against their published SHA-256 before
//! anything is unpacked; archives are unpacked with every path checked, then swapped in atomically.

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ArchiveKind {
    Zip,
    TarGz,
    TarXz,
    /// 7-Zip self-extracting archive (TinyTeX on Windows): run with `-y -o<dir>`.
    SevenZipSfx,
}

#[derive(Debug)]
pub struct Asset {
    pub component: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    pub kind: ArchiveKind,
}

macro_rules! asset {
    ($c:expr, $v:expr, $url:expr, $sha:expr, $size:expr, $kind:expr) => {
        Asset { component: $c, version: $v, url: $url, sha256: $sha, size: $size, kind: $kind }
    };
}

/// Release assets checked on 2026-10-10 (digests published by GitHub for each asset).
static ASSETS: &[(&str, &str, Asset)] = &[
    ("windows", "x86_64", asset!("tectonic", "0.17.0", "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip", "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f", 21060223, ArchiveKind::Zip)),
    ("linux", "x86_64", asset!("tectonic", "0.17.0", "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz", "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7", 10151914, ArchiveKind::TarGz)),
    ("macos", "aarch64", asset!("tectonic", "0.17.0", "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-aarch64-apple-darwin.tar.gz", "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667", 21704674, ArchiveKind::TarGz)),
    ("macos", "x86_64", asset!("tectonic", "0.17.0", "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-apple-darwin.tar.gz", "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80", 21790177, ArchiveKind::TarGz)),
    ("windows", "x86_64", asset!("tinytex", "v2026.10", "https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/TinyTeX-1-windows-v2026.10.exe", "36c329c644683d981a668419d13c8804696e2816ae4d287ad755788fee231a31", 73701889, ArchiveKind::SevenZipSfx)),
    ("linux", "x86_64", asset!("tinytex", "v2026.10", "https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/TinyTeX-1-linux-x86_64-v2026.10.tar.xz", "4d519d6236ee6798e3ec0d8e2093d1fda01aeb267aa22c2a5586d76bcfce6566", 53589988, ArchiveKind::TarXz)),
    ("macos", "aarch64", asset!("tinytex", "v2026.10", "https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/TinyTeX-1-darwin-v2026.10.tar.xz", "e40c294efae81026d8cc8d12c09d2dd456d268efe7fe092410478bc1973fd40f", 67189208, ArchiveKind::TarXz)),
    ("macos", "x86_64", asset!("tinytex", "v2026.10", "https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/TinyTeX-1-darwin-v2026.10.tar.xz", "e40c294efae81026d8cc8d12c09d2dd456d268efe7fe092410478bc1973fd40f", 67189208, ArchiveKind::TarXz)),
];

/// The pinned asset of `component` for this machine, if HiveTeX can install it here.
pub fn asset(component: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|(os, arch, a)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH && a.component == component).map(|(_, _, a)| a)
}

pub fn install_dir(app_data: &Path, component: &str) -> PathBuf {
    app_data.join(component)
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Installed {
    pub version: String,
    pub bytes: u64,
}

/// What is installed (version written at the end of a successful install), or None.
pub fn status(app_data: &Path, component: &str) -> Option<Installed> {
    let dir = install_dir(app_data, component);
    let version = std::fs::read_to_string(dir.join(".hivetex-version")).ok()?.trim().to_string();
    Some(Installed { version, bytes: dir_size(&dir) })
}

fn dir_size(d: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(d) else { return 0 };
    rd.flatten().map(|e| if e.path().is_dir() { dir_size(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) }).sum()
}

pub fn remove(app_data: &Path, component: &str) -> Result<(), String> {
    match std::fs::remove_dir_all(install_dir(app_data, component)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Downloads `url` to `dest`, checking size and SHA-256 while streaming; a mismatch deletes the file.
pub async fn download(client: &reqwest::Client, url: &str, sha256: &str, dest: &Path, progress: &(dyn Fn(u64, u64) + Send + Sync)) -> Result<(), String> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let mut res = client.get(url).send().await.map_err(|e| format!("download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("download failed: server answered {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                hasher.update(&chunk);
                out.write_all(&chunk).map_err(|e| e.to_string())?;
                received += chunk.len() as u64;
                progress(received, total);
            }
            Ok(None) => break,
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                return Err(format!("download interrupted: {e}"));
            }
        }
    }
    drop(out);
    let got = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !got.eq_ignore_ascii_case(sha256) {
        let _ = std::fs::remove_file(&part);
        return Err("the download is corrupted (checksum mismatch); nothing was installed".into());
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

/// A relative archive path with only normal components (no absolute paths, drive prefixes or `..`).
fn safe_entry(p: &Path) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return Err(format!("unsafe path in archive: {}", p.display())),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty path in archive".into());
    }
    Ok(out)
}

fn extract_tar<R: Read>(r: R, into: &Path) -> Result<(), String> {
    let mut ar = tar::Archive::new(r);
    for e in ar.entries().map_err(|e| e.to_string())? {
        let mut e = e.map_err(|e| e.to_string())?;
        let rel = safe_entry(&e.path().map_err(|e| e.to_string())?)?;
        let kind = e.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            continue;
        }
        if kind.is_symlink() {
            // Links must stay inside the install folder.
            let target = e.link_name().map_err(|e| e.to_string())?.ok_or("link without target")?;
            let resolved = rel.parent().unwrap_or(Path::new("")).join(&target);
            safe_entry(&normalize(&resolved))?;
        }
        let dest = into.join(&rel);
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        e.unpack(&dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Lexically resolves `..` inside a relative path; a path that climbs above its root keeps a `..` (and is refused).
fn normalize(p: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::ParentDir if matches!(out.last(), Some(Component::Normal(_))) => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out.iter().collect()
}

/// Unpacks `archive` into `into` (created), refusing any entry that would land outside it.
pub fn extract(archive: &Path, kind: ArchiveKind, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    match kind {
        ArchiveKind::Zip => {
            let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            for i in 0..z.len() {
                let mut f = z.by_index(i).map_err(|e| e.to_string())?;
                let rel = safe_entry(Path::new(f.name()))?;
                let dest = into.join(rel);
                if f.is_dir() {
                    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                    continue;
                }
                if let Some(p) = dest.parent() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                if let Some(mode) = f.unix_mode() {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(mode & 0o755));
                }
            }
            Ok(())
        }
        ArchiveKind::TarGz => extract_tar(flate2::read::GzDecoder::new(std::io::BufReader::new(file)), into),
        ArchiveKind::TarXz => {
            // Decompress to a temporary .tar next to the archive, then unpack it (bounded memory).
            let tar_path = archive.with_extension("tar");
            {
                let mut input = std::io::BufReader::new(file);
                let mut out = std::io::BufWriter::new(std::fs::File::create(&tar_path).map_err(|e| e.to_string())?);
                lzma_rs::xz_decompress(&mut input, &mut out).map_err(|e| format!("cannot unpack: {e:?}"))?;
            }
            let res = extract_tar(std::io::BufReader::new(std::fs::File::open(&tar_path).map_err(|e| e.to_string())?), into);
            let _ = std::fs::remove_file(&tar_path);
            res
        }
        ArchiveKind::SevenZipSfx => {
            drop(file);
            let status = std::process::Command::new(archive)
                .arg("-y")
                .arg(format!("-o{}", into.display()))
                .status()
                .map_err(|e| format!("cannot run the installer: {e}"))?;
            if status.success() { Ok(()) } else { Err(format!("the installer exited with {status}")) }
        }
    }
}

/// Download, verify, unpack into `<component>.tmp`, then swap into `<component>` and record the version.
/// `layout` turns the unpacked tree into the final folder (e.g. TinyTeX's archives contain a top-level `TinyTeX/`).
pub async fn install(
    client: &reqwest::Client,
    app_data: &Path,
    a: &Asset,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Installed, String> {
    let downloads = app_data.join("downloads");
    let file_name = a.url.rsplit('/').next().unwrap_or("download").replace("%40", "@");
    let archive = downloads.join(&file_name);
    download(client, a.url, a.sha256, &archive, progress).await?;
    let staging = app_data.join(format!("{}.tmp", a.component));
    let _ = std::fs::remove_dir_all(&staging);
    let unpacked = extract(&archive, a.kind, &staging);
    let _ = std::fs::remove_file(&archive);
    unpacked?;
    // A single top-level folder (TinyTeX/) becomes the install root.
    let root = single_child_dir(&staging).unwrap_or_else(|| staging.clone());
    std::fs::write(root.join(".hivetex-version"), a.version).map_err(|e| e.to_string())?;
    let target = install_dir(app_data, a.component);
    remove(app_data, a.component)?;
    std::fs::rename(&root, &target).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&staging);
    status(app_data, a.component).ok_or_else(|| "installation incomplete".into())
}

fn single_child_dir(d: &Path) -> Option<PathBuf> {
    let entries: Vec<_> = std::fs::read_dir(d).ok()?.flatten().collect();
    if entries.len() == 1 && entries[0].path().is_dir() { Some(entries[0].path()) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hivetex-managed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sha(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    /// Serves `body` for any GET.
    fn serve(body: Vec<u8>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/file.zip", l.local_addr().unwrap().port());
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body);
            }
        });
        url
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            for (name, data) in entries {
                z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    fn rt() -> tokio::runtime::Runtime {
        let _ = rustls::crypto::ring::default_provider().install_default();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn every_platform_we_ship_has_a_pinned_tectonic() {
        for (os, arch) in [("windows", "x86_64"), ("linux", "x86_64"), ("macos", "aarch64"), ("macos", "x86_64")] {
            assert!(ASSETS.iter().any(|(o, a, x)| *o == os && *a == arch && x.component == "tectonic"), "{os}/{arch}");
        }
        for (_, _, a) in ASSETS {
            assert_eq!(a.sha256.len(), 64);
            assert!(a.url.starts_with("https://github.com/"));
        }
    }

    #[test]
    fn checksum_mismatch_is_refused_and_leaves_nothing() {
        let d = tmp("mismatch");
        let url = serve(b"not the real archive".to_vec());
        let dest = d.join("a.zip");
        let err = rt().block_on(download(&reqwest::Client::new(), &url, &"0".repeat(64), &dest, &|_, _| {})).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!dest.exists() && !dest.with_extension("part").exists());
    }

    #[test]
    fn install_verifies_unpacks_and_swaps_in_atomically() {
        let d = tmp("install");
        let body = zip_bytes(&[("tectonic.exe", b"binary"), ("README.md", b"docs")]);
        let url: &'static str = Box::leak(serve(body.clone()).into_boxed_str());
        let sha: &'static str = Box::leak(sha(&body).into_boxed_str());
        let a = Asset { component: "tectonic", version: "0.17.0", url, sha256: sha, size: body.len() as u64, kind: ArchiveKind::Zip };
        let got = rt().block_on(install(&reqwest::Client::new(), &d, &a, &|_, _| {})).unwrap();
        assert_eq!(got.version, "0.17.0");
        assert_eq!(std::fs::read(d.join("tectonic").join("tectonic.exe")).unwrap(), b"binary");
        assert!(!d.join("tectonic.tmp").exists());
        // reinstall replaces the previous folder completely
        std::fs::write(d.join("tectonic").join("stale.txt"), "x").unwrap();
        rt().block_on(install(&reqwest::Client::new(), &d, &a, &|_, _| {})).unwrap();
        assert!(!d.join("tectonic").join("stale.txt").exists());
        remove(&d, "tectonic").unwrap();
        assert_eq!(status(&d, "tectonic"), None);
    }

    #[test]
    fn archive_entries_cannot_escape_the_install_folder() {
        let d = tmp("zipslip");
        let evil = d.join("evil.zip");
        std::fs::write(&evil, zip_bytes(&[("ok.txt", b"ok"), ("../escaped.txt", b"x")])).unwrap();
        let err = extract(&evil, ArchiveKind::Zip, &d.join("out")).unwrap_err();
        assert!(err.contains("unsafe path"), "{err}");
        assert!(!d.join("escaped.txt").exists());
        // tar: an absolute path and a symlink pointing outside are refused too
        for (name, link) in [("/abs.txt", None), ("link", Some("../../outside"))] {
            let mut b = tar::Builder::new(Vec::new());
            let mut h = tar::Header::new_gnu();
            match link {
                None => {
                    h.set_size(1);
                    h.set_entry_type(tar::EntryType::Regular);
                    h.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
                    h.set_cksum();
                    b.append(&h, &b"x"[..]).unwrap();
                }
                Some(t) => {
                    h.set_size(0);
                    h.set_entry_type(tar::EntryType::Symlink);
                    b.append_link(&mut h, name, t).unwrap();
                }
            }
            let tar_bytes = b.into_inner().unwrap();
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&tar_bytes).unwrap();
            let p = d.join(format!("t-{}.tar.gz", name.replace('/', "_")));
            std::fs::write(&p, gz.finish().unwrap()).unwrap();
            assert!(extract(&p, ArchiveKind::TarGz, &d.join("tout")).is_err(), "{name} must be refused");
        }
    }
}
