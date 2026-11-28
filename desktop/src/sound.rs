//! Synthesized task cues. The caller owns the sound preference and suppresses headless playback.
//! The pitch, filter, and envelope are adapted from OpenCode Rune. See THIRD_PARTY_NOTICES.md.

use std::f64::consts::TAU;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::{SystemTime, UNIX_EPOCH};

const SAMPLE_RATE: u32 = 48_000;
const NOTE_FRAMES: u32 = SAMPLE_RATE * 9 / 100;
const NOTE_SPACING: u32 = SAMPLE_RATE * 6 / 100;
const PENTATONIC: [i32; 5] = [0, 2, 4, 7, 9];

#[derive(Clone, Copy)]
enum Cue {
    Completion,
    Attention,
}

pub fn play() {
    enqueue(Cue::Completion);
}

pub fn attention() {
    enqueue(Cue::Attention);
}

fn enqueue(cue: Cue) {
    static PLAYER: OnceLock<Option<SyncSender<Cue>>> = OnceLock::new();
    let player = PLAYER.get_or_init(|| {
        let (sender, receiver) = sync_channel(2);
        std::thread::Builder::new()
            .name("desktop-sound".into())
            .spawn(move || {
                while let Ok(cue) = receiver.recv() {
                    if let Ok(file) = WaveFile::new(&render(cue)) {
                        play_file(&file.0);
                    }
                }
            })
            .ok()
            .map(|_| sender)
    });
    if let Some(sender) = player {
        let _ = sender.try_send(cue);
    }
}

fn render(cue: Cue) -> Vec<u8> {
    let notes = match cue {
        Cue::Completion => [0, 3],
        Cue::Attention => [3, 0],
    };
    let mut samples = vec![0.0; (NOTE_FRAMES + NOTE_SPACING) as usize];
    for (index, step) in notes.into_iter().enumerate() {
        let start = index * NOTE_SPACING as usize;
        synthesize(step, &mut samples[start..][..NOTE_FRAMES as usize]);
    }
    let data_bytes = samples.len() as u32 * 2;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM format chunk length
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes()); // bytes per frame
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    for sample in samples {
        let pcm = (sample.clamp(-1.0, 1.0) * f64::from(i16::MAX)).round() as i16;
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    wav
}

fn synthesize(step: i32, output: &mut [f64]) {
    // OpenCode Rune's pentatonic scale starts at MIDI note 74.
    let pitch = 74 + 12 * step.div_euclid(5) + PENTATONIC[step.rem_euclid(5) as usize];
    let frequency = 440.0 * 2f64.powf(f64::from(pitch - 69) / 12.0);
    let angular_frequency = TAU * frequency / f64::from(SAMPLE_RATE);
    let (sine, cosine) = angular_frequency.sin_cos();
    // OpenCode Rune's normalized band-pass biquad for a high-Q pebble click.
    let alpha = sine / (2.0 * 14.0);
    let b0 = alpha / (1.0 + alpha);
    let a1 = -2.0 * cosine / (1.0 + alpha);
    let a2 = (1.0 - alpha) / (1.0 + alpha);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    let mut noise = 0xa3f9_61b7_u32;
    let last_frame = output.len() - 1;
    for (frame, sample) in output.iter_mut().enumerate() {
        noise ^= noise << 13;
        noise ^= noise >> 17;
        noise ^= noise << 5;
        let input = f64::from(noise) / f64::from(u32::MAX) * 2.0 - 1.0;
        let filtered = b0 * (input - x2) - a1 * y1 - a2 * y2;
        (x1, x2, y1, y2) = (input, x1, filtered, y1);
        let time = frame as f64 / f64::from(SAMPLE_RATE);
        // Fast exponential attack and slower exponential decay, as in the pebble envelope.
        let gain = if time < 0.002 {
            0.0001 * 1500f64.powf(time / 0.002)
        } else {
            0.15 * (0.0001f64 / 0.15).powf((time - 0.002) / 0.088)
        };
        let fade_out = ((last_frame - frame) as f64 / 96.0).min(1.0);
        let tone = (angular_frequency * frame as f64).sin();
        *sample += (tone * 0.65 + filtered * 0.35) * gain * fade_out;
    }
}

struct WaveFile(PathBuf);

impl WaveFile {
    fn new(bytes: &[u8]) -> io::Result<Self> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("lofibot-cue-{}-{stamp}.wav", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        // Close the handle before returning or cleaning up, including on Windows.
        let written = file.write_all(bytes);
        drop(file);
        let wave = Self(path);
        written?;
        Ok(wave)
    }
}

impl Drop for WaveFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn play_file(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = run_player(Command::new("/usr/bin/afplay").arg(path));
    #[cfg(target_os = "linux")]
    if !run_player(Command::new("paplay").arg(path)) {
        let _ = run_player(Command::new("aplay").arg(path));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = run_player(
            Command::new("powershell.exe")
                .creation_flags(CREATE_NO_WINDOW)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "(New-Object System.Media.SoundPlayer -ArgumentList $env:LOFIBOT_CUE_FILE).PlaySync()",
                ])
                .env("LOFIBOT_CUE_FILE", path),
        );
    }
}

fn run_player(command: &mut Command) -> bool {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cues_are_distinct_valid_pcm_wave_files() {
        let completion = render(Cue::Completion);
        let attention = render(Cue::Attention);
        assert_ne!(completion, attention);
        for bytes in [completion, attention] {
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(&bytes[8..16], b"WAVEfmt ");
            assert_eq!(&bytes[36..40], b"data");
            let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            assert_eq!(word(4) as usize + 8, bytes.len());
            assert_eq!(word(24), SAMPLE_RATE);
            assert_eq!(word(40) as usize + 44, bytes.len());
            let samples = bytes[44..]
                .chunks_exact(2)
                .map(|bytes| i16::from_le_bytes(bytes.try_into().unwrap()));
            let peak = samples.map(i16::unsigned_abs).max().unwrap();
            assert!(peak > 100 && peak < 10_000);
            assert_eq!(&bytes[bytes.len() - 2..], &[0, 0]);
        }
    }
}
