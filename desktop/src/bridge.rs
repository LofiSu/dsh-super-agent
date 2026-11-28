use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use rune::Waker;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "text", rename_all = "lowercase")]
pub enum Event {
    Delta(String),
    Reply(String),
    Status(String),
    Error(String),
}

impl Event {
    fn terminal(&self) -> bool {
        matches!(self, Self::Reply(_) | Self::Error(_))
    }
}

#[derive(Clone, Default)]
pub struct Shutdown(Arc<BridgeControl>);

#[derive(Default)]
struct BridgeControl {
    input: Mutex<Option<ChildStdin>>,
    requested: AtomicBool,
}

impl Shutdown {
    pub fn request(&self) {
        self.0.requested.store(true, Ordering::SeqCst);
        self.close_input();
    }

    fn close_input(&self) {
        if let Ok(mut slot) = self.0.input.try_lock()
            && let Some(mut input) = slot.take()
        {
            let _ = input.write_all(b"{\"shutdown\":true}\n");
        }
    }
}

struct Bridge {
    child: Child,
    shutdown: Shutdown,
    output: BufReader<ChildStdout>,
}

impl Bridge {
    fn start(shutdown: Shutdown) -> io::Result<Self> {
        if shutdown.0.requested.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Desktop is closing",
            ));
        }
        let executable = std::env::var_os("DS_AGENT_DESKTOP_CLI");
        let mut command = executable.map_or_else(
            || {
                let mut command = Command::new("node");
                command
                    .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
                    .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../dist/cli/main.js"));
                command
            },
            Command::new,
        );
        let mut child = command
            .arg("desktop-bridge")
            .env(
                "DS_AGENT_DESKTOP_PARENT_PID",
                std::process::id().to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        *shutdown.0.input.lock().expect("bridge stdin lock") = child.stdin.take();
        if shutdown.0.requested.load(Ordering::SeqCst) {
            shutdown.close_input();
        }
        let output = BufReader::new(child.stdout.take().expect("piped stdout"));
        Ok(Self {
            child,
            shutdown,
            output,
        })
    }

    fn send(&mut self, text: &str, emit: &impl Fn(Event)) -> io::Result<()> {
        {
            let mut slot = self.shutdown.0.input.lock().expect("bridge stdin lock");
            let input = slot.as_mut().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "Agent bridge is closing")
            })?;
            serde_json::to_writer(&mut *input, &serde_json::json!({ "text": text }))?;
            input.write_all(b"\n")?;
            input.flush()?;
        }
        if self.shutdown.0.requested.load(Ordering::SeqCst) {
            self.shutdown.close_input();
        }
        let mut line = String::new();
        loop {
            line.clear();
            if self.output.read_line(&mut line)? == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Agent bridge exited",
                ));
            }
            let event: Event = serde_json::from_str(&line)?;
            let terminal = event.terminal();
            emit(event);
            if terminal {
                return Ok(());
            }
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.shutdown.close_input();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while matches!(self.child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn connect(waker: Waker) -> (Sender<String>, Receiver<Event>, Shutdown) {
    let (requests, pending) = channel::<String>();
    let (events, replies) = channel();
    let shutdown = Shutdown::default();
    let worker_shutdown = shutdown.clone();
    std::thread::spawn(move || {
        let emit = |event| {
            if events.send(event).is_ok() {
                waker();
            }
        };
        let mut bridge = None;
        for text in pending {
            let result = (|| {
                if bridge.is_none() {
                    bridge = Some(Bridge::start(worker_shutdown.clone())?);
                }
                bridge
                    .as_mut()
                    .expect("connected bridge")
                    .send(&text, &emit)
            })();
            if let Err(error) = result {
                bridge = None;
                emit(Event::Error(format!(
                    "Agent connection failed: {error}. Build the CLI with pnpm build and check your Agent configuration."
                )));
            }
        }
    });
    (requests, replies, shutdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shutdown_requested_during_an_input_write_prevents_a_spawn() {
        let shutdown = Shutdown::default();
        let input = shutdown.0.input.lock().unwrap();
        shutdown.request();
        drop(input);
        assert!(
            matches!(Bridge::start(shutdown), Err(error) if error.kind() == io::ErrorKind::Interrupted)
        );
    }
}
