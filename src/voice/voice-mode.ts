/**
 * Voice Mode — push-to-talk voice input.
 *
 * Records audio while a key is held, then sends to a speech-to-text
 * service for transcription. The transcribed text becomes the user's input.
 */

import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";
import { mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";

export interface VoiceConfig {
  sttProvider: "whisper-local" | "whisper-api" | "none";
  whisperApiKey?: string;
  whisperModel?: string;
  recordingFormat?: "wav" | "mp3";
  sampleRate?: number;
}

let _recording: Subprocess | null = null;
let _recordingPath: string | null = null;

function getVoiceDir(): string {
  return join(getConfigDir(), "voice");
}

/**
 * Start recording audio via system microphone.
 * Uses sox (rec) on macOS/Linux.
 */
export async function startRecording(): Promise<void> {
  if (_recording) return; // Already recording

  const dir = getVoiceDir();
  await mkdir(dir, { recursive: true });

  _recordingPath = join(dir, `recording-${Date.now()}.wav`);

  // Use sox/rec for cross-platform recording
  // Check if rec (sox) is installed first
  const check = spawn(["which", "rec"], { stdout: "pipe", stderr: "pipe" });
  await check.exited;
  if (check.exitCode !== 0) {
    _recordingPath = null;
    throw new Error(
      "Voice mode requires sox. Install it:\n" +
      "  macOS:  brew install sox\n" +
      "  Linux:  apt install sox\n" +
      "  Windows: not supported (use WSL)"
    );
  }

  _recording = spawn(["rec", "-q", "-r", "16000", "-c", "1", "-b", "16", _recordingPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Stop recording and return the audio file path.
 */
export async function stopRecording(): Promise<string | null> {
  if (!_recording || !_recordingPath) return null;

  _recording.kill("SIGINT"); // Graceful stop
  await _recording.exited.catch(() => {});
  _recording = null;

  const path = _recordingPath;
  _recordingPath = null;

  return existsSync(path) ? path : null;
}

/**
 * Check if currently recording.
 */
export function isRecording(): boolean {
  return _recording !== null;
}

/**
 * Transcribe audio file using Whisper API.
 */
export async function transcribeWhisperAPI(
  audioPath: string,
  apiKey: string,
  model: string = "whisper-1",
): Promise<string> {
  const file = Bun.file(audioPath);
  const formData = new FormData();
  formData.append("file", file);
  formData.append("model", model);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) throw new Error(`Whisper API error: ${response.status}`);
  const data = (await response.json()) as { text: string };
  return data.text;
}

/**
 * Transcribe audio file using local Whisper (whisper.cpp or faster-whisper).
 */
export async function transcribeWhisperLocal(audioPath: string): Promise<string> {
  // Try whisper.cpp first
  const proc = spawn(
    ["whisper", "--model", "base", "--output-format", "txt", "--no-timestamps", audioPath],
    { stdout: "pipe", stderr: "pipe" },
  );

  const output = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Try faster-whisper as fallback
    const proc2 = spawn(["faster-whisper", audioPath, "--model", "base"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output2 = (await new Response(proc2.stdout).text()).trim();
    await proc2.exited;
    return output2 || "Failed to transcribe audio";
  }

  return output;
}

/**
 * Full voice-to-text pipeline: record -> stop -> transcribe.
 */
export async function transcribeRecording(config: VoiceConfig): Promise<string | null> {
  const audioPath = await stopRecording();
  if (!audioPath) return null;

  try {
    let text: string;
    if (config.sttProvider === "whisper-api" && config.whisperApiKey) {
      text = await transcribeWhisperAPI(audioPath, config.whisperApiKey, config.whisperModel);
    } else if (config.sttProvider === "whisper-local") {
      text = await transcribeWhisperLocal(audioPath);
    } else {
      return null;
    }

    // Cleanup recording
    await unlink(audioPath).catch(() => {});
    return text.trim();
  } catch (err) {
    await unlink(audioPath).catch(() => {});
    throw err;
  }
}

/**
 * Check if voice recording tools are available.
 */
export async function checkVoiceAvailability(): Promise<{ available: boolean; details: string }> {
  try {
    const proc = spawn(["which", "rec"], { stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    if (output) {
      return { available: true, details: "sox/rec available for audio recording" };
    }
    return {
      available: false,
      details: "Install sox: brew install sox (macOS) or apt install sox (Linux)",
    };
  } catch {
    return { available: false, details: "Cannot detect audio recording tools" };
  }
}
