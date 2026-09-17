import { splitTelegramHtml, stripHtml } from "./render.js";

export interface TelegramUser { id: number; is_bot?: boolean; username?: string; }
export interface TelegramChat { id: number; type: "private" | "group" | "supergroup" | "channel"; }
export interface TelegramMessage { message_id: number; text?: string; from?: TelegramUser; chat: TelegramChat; }
export interface TelegramCallback { id: string; from: TelegramUser; data?: string; message?: TelegramMessage; }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback; }
export interface TelegramButton { text: string; callback_data: string; }
export interface TelegramCommand { command: string; description: string; }
export interface TelegramSendOptions {
  inlineKeyboard?: TelegramButton[][];
  persistentKeyboard?: string[][];
}

type ApiResult<T> = { ok: boolean; result: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };

export class TelegramApiError extends Error {
  constructor(message: string, readonly errorCode: number | undefined, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return await this.call<TelegramUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, signal);
  }

  async sendText(chatId: number, html: string, options?: TelegramSendOptions): Promise<number[]> {
    const ids: number[] = [];
    const chunks = splitTelegramHtml(html);
    for (let index = 0; index < chunks.length; index++) {
      const reply_markup = index === chunks.length - 1 ? replyMarkup(options) : undefined;
      try {
        const message = await this.call<TelegramMessage>("sendMessage", { chat_id: chatId, text: chunks[index], parse_mode: "HTML", reply_markup });
        ids.push(message.message_id);
      } catch (error) {
        if (error instanceof TelegramApiError && error.errorCode !== 400) throw error;
        const message = await this.call<TelegramMessage>("sendMessage", { chat_id: chatId, text: stripHtml(chunks[index]), reply_markup });
        ids.push(message.message_id);
      }
    }
    return ids;
  }

  async editText(chatId: number, messageId: number, html: string, inlineKeyboard?: TelegramButton[][]): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined });
  }

  async answerCallback(id: string, text?: string): Promise<void> { await this.call("answerCallbackQuery", { callback_query_id: id, text }); }
  async typing(chatId: number): Promise<void> { await this.call("sendChatAction", { chat_id: chatId, action: "typing" }); }
  async setCommands(chatId: number, commands: TelegramCommand[]): Promise<void> {
    await this.call("setMyCommands", { commands, scope: { type: "chat", chat_id: chatId } });
  }
  async deleteCommands(chatId?: number): Promise<void> {
    const scopes: object[] = [{}, { scope: { type: "all_private_chats" } }];
    if (chatId !== undefined) scopes.push({ scope: { type: "chat", chat_id: chatId } });
    await Promise.all(scopes.map(async (body) => await this.call("deleteMyCommands", body)));
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
        });
        const data = await response.json() as ApiResult<T>;
        if (!response.ok || !data.ok) {
          const code = data.error_code ?? response.status;
          const retryable = code === 429 || code >= 500;
          throw new TelegramApiError(data.description ?? `Telegram ${method} failed (${code})`, code, retryable, data.parameters?.retry_after ? data.parameters.retry_after * 1000 : undefined);
        }
        return data.result;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof TelegramApiError && !error.retryable) throw error;
        const message = (error instanceof Error ? error.message : String(error)).replaceAll(this.token, "[REDACTED]");
        lastError = error instanceof TelegramApiError
          ? new TelegramApiError(message, error.errorCode, error.retryable, error.retryAfterMs)
          : new Error(message);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, error instanceof TelegramApiError && error.retryAfterMs ? error.retryAfterMs : 250 * 2 ** attempt));
      }
    }
    throw lastError ?? new Error(`Telegram ${method} failed`);
  }
}

function replyMarkup(options?: TelegramSendOptions): object | undefined {
  if (options?.inlineKeyboard) return { inline_keyboard: options.inlineKeyboard };
  if (options?.persistentKeyboard) {
    return {
      keyboard: options.persistentKeyboard.map((row) => row.map((text) => ({ text }))),
      resize_keyboard: true,
      is_persistent: true,
    };
  }
  return undefined;
}
