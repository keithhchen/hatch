use clap::{Parser, Subcommand};
use hatch_local_runner::{LocalRunner, ToolCallRequest};
use serde_json::json;
use std::error::Error;
use std::io::{BufRead, Write};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "hatch-local-runner")]
#[command(about = "Sandbox-confined Hatch Local Runner CLI skeleton")]
struct Cli {
    #[arg(long)]
    sandbox: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    List {
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    Stat {
        path: PathBuf,
    },
    Search {
        query: String,
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long, default_value_t = 100)]
        max_results: usize,
    },
    Read {
        path: PathBuf,
    },
    WriteFile {
        path: PathBuf,
        #[arg(long)]
        content: String,
    },
    AppendFile {
        path: PathBuf,
        #[arg(long)]
        content: String,
    },
    Copy {
        src: PathBuf,
        dst: PathBuf,
        #[arg(long)]
        overwrite: bool,
    },
    Move {
        src: PathBuf,
        dst: PathBuf,
        #[arg(long)]
        overwrite: bool,
    },
    ApplyPatch {
        path: PathBuf,
        #[arg(
            long,
            conflicts_with = "patch_file",
            required_unless_present = "patch_file"
        )]
        patch: Option<String>,
        #[arg(long)]
        patch_file: Option<PathBuf>,
    },
    ToolCall {
        #[arg(
            long,
            conflicts_with = "request_file",
            required_unless_present = "request_file"
        )]
        request: Option<String>,
        #[arg(long)]
        request_file: Option<PathBuf>,
    },
    Serve,
}

fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let runner = LocalRunner::new(&cli.sandbox)?;

    match cli.command {
        Command::List { path } => print_json(&runner.list(path)?)?,
        Command::Stat { path } => print_json(&runner.stat(path)?)?,
        Command::Search {
            query,
            path,
            max_results,
        } => print_json(&runner.search(path, &query, max_results)?)?,
        Command::Read { path } => {
            print_json(&runner.read_file_result(path)?)?;
        }
        Command::WriteFile { path, content } => {
            runner.write_file(path, &content)?;
            print_json(&json!({ "ok": true }))?;
        }
        Command::AppendFile { path, content } => {
            runner.append_file(path, &content)?;
            print_json(&json!({ "ok": true }))?;
        }
        Command::Copy {
            src,
            dst,
            overwrite,
        } => {
            runner.copy(src, dst, overwrite)?;
            print_json(&json!({ "ok": true }))?;
        }
        Command::Move {
            src,
            dst,
            overwrite,
        } => {
            runner.move_path(src, dst, overwrite)?;
            print_json(&json!({ "ok": true }))?;
        }
        Command::ApplyPatch {
            path,
            patch,
            patch_file,
        } => {
            let patch_text = match (patch, patch_file) {
                (Some(text), None) => text,
                (None, Some(path)) => runner.read_file(path)?,
                _ => unreachable!("clap enforces patch input shape"),
            };
            runner.apply_patch(path, &patch_text)?;
            print_json(&json!({ "ok": true }))?;
        }
        Command::ToolCall {
            request,
            request_file,
        } => {
            let request_text = match (request, request_file) {
                (Some(text), None) => text,
                (None, Some(path)) => std::fs::read_to_string(path)?,
                _ => unreachable!("clap enforces request input shape"),
            };
            let request: ToolCallRequest = serde_json::from_str(&request_text)?;
            print_json(&runner.execute_tool_call_request(request))?;
        }
        Command::Serve => serve_jsonl(&runner)?,
    }

    Ok(())
}

fn print_json(value: &impl serde::Serialize) -> Result<(), Box<dyn Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn serve_jsonl(runner: &LocalRunner) -> Result<(), Box<dyn Error>> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<ToolCallRequest>(&line) {
            Ok(request) => {
                serde_json::to_writer(&mut stdout, &runner.execute_tool_call_request(request))?;
            }
            Err(error) => {
                serde_json::to_writer(
                    &mut stdout,
                    &json!({
                        "type": "sidecar.error",
                        "error": {
                            "code": "invalid_json",
                            "message": error.to_string()
                        }
                    }),
                )?;
            }
        }
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }

    Ok(())
}
