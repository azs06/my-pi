/**
 * gateway.ts – Shared interface for chat backends (Telegram / Slack).
 *
 * Both gateways accept incoming user messages via an `onMessage` callback
 * and expose:
 *  • send()   → the configured default destination (startup / cron results)
 *  • sendTo() → a specific chat/channel for interactive replies or tool output
 */
import type { ProgressUpdate } from "./pi-session.js";

/** Callback signature passed to every gateway constructor. */
export type GatewayMessageHandler = (
  text: string,
  chatId: string,
  onProgress: (update: ProgressUpdate) => void,
  onDone: (text: string) => void,
  onError: (err: Error) => void
) => void;

/** Minimal surface both Telegram and Slack gateways expose. */
export interface ChatGateway {
  /** Send a message to the default/allowed channel (outbound only). */
  send(text: string): Promise<void>;

  /** Send a message to a specific chat/channel. */
  sendTo(chatId: string, text: string): Promise<void>;

  /** Send a file to a specific chat/channel. */
  sendFileTo(chatId: string, filePath: string, caption?: string): Promise<void>;

  /** Cleanly stop the gateway. */
  stop(): Promise<void>;
}
