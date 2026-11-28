#![forbid(unsafe_code)]

mod bridge;
mod sound;

use std::sync::mpsc::{Receiver, Sender};

use bridge::Event;
use rune::tok::{self, Theme, motion, type_};
use rune::{App, AppSpec, Cx, El, ScrollSpec, TextEdit, Tx, col, el, row, text, text_input};

#[derive(Default)]
struct Turn {
    prompt: String,
    reply: String,
    failed: bool,
    progress: Vec<String>,
}

struct Chat {
    draft: TextEdit,
    turns: Vec<Turn>,
    status: String,
    busy: bool,
    audio: bool,
    fixture: bool,
    requests: Option<Sender<String>>,
    events: Option<Receiver<Event>>,
    shutdown: bridge::Shutdown,
}

impl Default for Chat {
    fn default() -> Self {
        Self {
            draft: TextEdit::new(""),
            turns: Vec::new(),
            status: "Ready".into(),
            busy: false,
            audio: false,
            fixture: false,
            requests: None,
            events: None,
            shutdown: bridge::Shutdown::default(),
        }
    }
}

impl Chat {
    fn fixture(&mut self) {
        self.fixture = true;
        self.draft = TextEdit::new("Summarize the tasks");
        self.turns.push(Turn {
            prompt: "你好！请展示一个代码例子。".into(),
            reply: "可以。这里是一个简单的 Rust 例子。\n\n```rust\nfn main() {\n    println!(\"Hello from Rune!\");\n}\n```".into(),
            ..Turn::default()
        });
    }

    fn send(&mut self) {
        let prompt = self.draft.text.trim().to_owned();
        if self.busy || prompt.is_empty() {
            return;
        }
        self.draft = TextEdit::new("");
        self.draft.focused = true;
        self.turns.push(Turn {
            prompt: prompt.clone(),
            ..Turn::default()
        });
        self.busy = true;
        self.status = "Sending…".into();
        if self.fixture {
            self.apply(Event::Reply(
                "Offline example · 2 tasks completed, 1 pending.".into(),
            ));
        } else if !self
            .requests
            .as_ref()
            .is_some_and(|sender| sender.send(prompt).is_ok())
        {
            self.apply(Event::Error("Could not connect to the Agent.".into()));
        }
    }

    fn apply(&mut self, event: Event) {
        let Some(turn) = self.turns.last_mut() else {
            return;
        };
        match event {
            Event::Delta(body) => turn.reply.push_str(&body),
            Event::Status(status) => {
                if self.audio && !self.fixture && status.starts_with("Needs approval") {
                    sound::attention();
                }
                if status != "Ready" && turn.progress.last() != Some(&status) {
                    turn.progress.push(status.clone());
                }
                self.status = status;
            }
            Event::Reply(body) => {
                turn.reply = body;
                let awaiting_approval = self.status.starts_with("Needs approval");
                if !awaiting_approval {
                    self.status = "Ready".into();
                }
                self.busy = false;
                if self.audio && !self.fixture && !awaiting_approval {
                    sound::play();
                }
            }
            Event::Error(body) => {
                turn.failed = true;
                turn.reply = body;
                self.status = "Request failed".into();
                self.busy = false;
                if self.audio && !self.fixture {
                    sound::attention();
                }
            }
        }
    }

    fn close(&mut self, _: &mut Tx) {
        self.requests.take();
        self.shutdown.request();
    }

    fn poll(&mut self, _: f64, _: &mut Tx) -> bool {
        let mut changed = false;
        while let Some(event) = self
            .events
            .as_ref()
            .and_then(|events| events.try_recv().ok())
        {
            self.apply(event);
            changed = true;
        }
        changed
    }
}

fn button(
    key: &'static str,
    title: &'static str,
    theme: Theme,
    active: bool,
    action: impl Fn(&mut Chat) + 'static,
) -> El {
    el().key(key)
        .role("button")
        .label(title)
        .focusable(true)
        .h(40.0)
        .px(14.0)
        .center()
        .radius(9.0)
        .motion(motion::SNAPPY)
        .fill(if active {
            theme.text.alpha(0.14)
        } else {
            theme.card
        })
        .hover(theme.text.alpha(0.18))
        .press_scale(0.96)
        .child(text(title).font(type_::LABEL).color(theme.text))
        .on_press(action)
}

fn reply_blocks(reply: &str, theme: Theme) -> El {
    let mut blocks = col().w_full().gap(10.0);
    for (index, part) in reply.split("```").enumerate() {
        if index % 2 == 0 {
            let value = part.trim();
            if !value.is_empty() {
                blocks = blocks.child(
                    text(value.to_owned())
                        .font(type_::BODY)
                        .selectable(true)
                        .color(theme.text)
                        .w_full(),
                );
            }
        } else {
            let body = part
                .split_once('\n')
                .map_or(part, |(_, code)| code)
                .trim_end();
            blocks = blocks.child(
                el().w_full()
                    .padding(12.0)
                    .radius(8.0)
                    .fill(theme.bg)
                    .child(
                        text(body.to_owned())
                            .font(type_::BODY.mono())
                            .selectable(true)
                            .color(theme.text)
                            .w_full(),
                    ),
            );
        }
    }
    blocks
}

fn view(chat: &Chat, cx: &mut Cx<Chat>) -> El {
    let theme = tok::theme(cx.system_dark());
    let mut transcript = col().key("transcript").w_full().gap(12.0);
    for (index, turn) in chat.turns.iter().enumerate() {
        let mut item = col()
            .key(format!("turn-{index}"))
            .w_full()
            .gap(8.0)
            .padding(16.0)
            .radius(12.0)
            .fill(theme.card);
        item = item
            .child(text("You").font(type_::LABEL).color(theme.text_secondary))
            .child(
                text(turn.prompt.clone())
                    .font(type_::BODY)
                    .selectable(true)
                    .color(theme.text)
                    .w_full(),
            );
        for status in &turn.progress {
            item = item.child(
                text(status.clone())
                    .font(type_::LABEL)
                    .color(theme.text_secondary)
                    .w_full(),
            );
        }
        if !turn.reply.is_empty() {
            item = item
                .child(
                    text(if turn.failed { "Error" } else { "Agent" })
                        .font(type_::LABEL)
                        .color(theme.text_secondary),
                )
                .child(reply_blocks(&turn.reply, theme));
        }
        transcript = transcript.child(item);
    }
    let composer = text_input(&chat.draft, type_::BODY)
        .key("composer")
        .label("Message")
        .placeholder("Message the agent", theme.text_secondary)
        .color(theme.text)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h(44.0)
        .padding(12.0)
        .radius(9.0)
        .fill(theme.card)
        .on_edit(|state: &mut Chat| &mut state.draft)
        .on_submit(|state: &mut Chat, _| state.send());
    col()
        .w_full()
        .h_full()
        .padding(24.0)
        .pt(cx.titlebar_inset().max(24.0))
        .gap(12.0)
        .fill(theme.bg)
        .child(
            row()
                .w_full()
                .justify_between()
                .center_y()
                .child(
                    text("DeepSeek Super Agent")
                        .font(type_::TITLE)
                        .color(theme.text),
                )
                .child(button(
                    "audio",
                    if chat.audio { "Sound on" } else { "Sound off" },
                    theme,
                    chat.audio,
                    |state| {
                        state.audio = !state.audio;
                    },
                )),
        )
        .child(
            transcript
                .grow(1.0)
                .shrink()
                .min_h(0.0)
                .scroll(ScrollSpec::stick_bottom()),
        )
        .child(
            text(chat.status.clone())
                .key("status")
                .font(type_::LABEL)
                .color(theme.text_secondary),
        )
        .child(
            row()
                .w_full()
                .center_y()
                .gap(8.0)
                .child(composer)
                .child(button(
                    "send",
                    if chat.busy { "Working…" } else { "Send" },
                    theme,
                    !chat.busy,
                    Chat::send,
                )),
        )
}

fn main() {
    App::new(AppSpec {
        min_size: Some((460.0, 420.0)),
        scenes: &[("example", Chat::fixture)],
        setup: Some(|chat, waker| {
            if !chat.fixture {
                let (requests, events, shutdown) = bridge::connect(waker);
                chat.requests = Some(requests);
                chat.events = Some(events);
                chat.shutdown = shutdown;
            }
        }),
        poll: Some(Chat::poll),
        ..AppSpec::new("DeepSeek Super Agent", (840.0, 640.0), Chat::default, view)
    })
    .on_close(Chat::close)
    .on_quit(Chat::close)
    .run();
}
