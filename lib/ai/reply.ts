/**
 * Respuestas con IA a los DMs que no disparan ninguna campana.
 *
 * Parche propio, no viene de diwenne/openreply. Vive en ficheros aparte y se
 * engancha en un unico punto de processMessage para que los merges con upstream
 * sigan siendo manejables.
 *
 * Se activa solo si ANTHROPIC_API_KEY esta puesta. Sin ella, todo esto es un
 * no-op y OpenReply se comporta exactamente como antes.
 *
 * Env:
 *   ANTHROPIC_API_KEY   obligatoria para que la IA responda
 *   AI_MODEL            opcional, por defecto claude-sonnet-5
 *   AI_SYSTEM_PROMPT    opcional, el tono y los limites del asistente
 *   AI_MAX_TOKENS       opcional, por defecto 400 (un DM no es un ensayo)
 */
import { getRedisConnection } from "@/lib/queue/client";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 400;

/** Turnos guardados por conversacion. Cada turno son dos entradas (tu y el). */
const MAX_TURNS = 20;

/**
 * El historial caduca a las 24h a proposito: es la ventana de mensajeria de
 * Meta. Pasada, no puedes responder texto libre igualmente, asi que guardar mas
 * seria ocupar Redis con algo que no se puede usar.
 */
const HISTORY_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_SYSTEM =
  "Eres el asistente de atencion al cliente de esta cuenta de Instagram. " +
  "Responde breve, en el idioma del cliente. No inventes datos que no tengas: " +
  "si no sabes algo, dilo y ofrece que una persona del equipo lo confirme.";

export type Turn = { role: "user" | "assistant"; content: string };

export function isAiReplyEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function historyKey(instagramAccountId: string, userId: string): string {
  return `ai:history:${instagramAccountId}:${userId}`;
}

export async function loadHistory(
  instagramAccountId: string,
  userId: string
): Promise<Turn[]> {
  const raw = await getRedisConnection().lrange(
    historyKey(instagramAccountId, userId),
    0,
    MAX_TURNS * 2 - 1
  );
  // lpush deja lo mas reciente primero; la API los quiere en orden cronologico.
  return raw
    .reverse()
    .map((entry) => {
      try {
        return JSON.parse(entry) as Turn;
      } catch {
        return null; // una entrada corrupta no debe tumbar la conversacion
      }
    })
    .filter((turn): turn is Turn => turn !== null);
}

async function appendHistory(
  instagramAccountId: string,
  userId: string,
  turns: Turn[]
): Promise<void> {
  const key = historyKey(instagramAccountId, userId);
  const redis = getRedisConnection();
  await redis
    .multi()
    .lpush(key, ...turns.map((t) => JSON.stringify(t)).reverse())
    .ltrim(key, 0, MAX_TURNS * 2 - 1)
    .expire(key, HISTORY_TTL_SECONDS)
    .exec();
}

/**
 * Pide una respuesta a Claude y la devuelve. Devuelve null si la IA esta
 * desactivada, si el texto entrante viene vacio o si el modelo no da texto:
 * quien llama debe tratar null como "no respondas", nunca como error.
 */
export async function generateAiReply({
  instagramAccountId,
  userId,
  text,
}: {
  instagramAccountId: string;
  userId: string;
  text: string;
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !text.trim()) return null;

  const history = await loadHistory(instagramAccountId, userId);
  const messages: Turn[] = [...history, { role: "user", content: text }];

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_MODEL,
      max_tokens: Number(process.env.AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
      system: process.env.AI_SYSTEM_PROMPT || DEFAULT_SYSTEM,
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }

  const body = (await response.json()) as {
    content?: { type: string; text?: string }[];
  };
  const reply = (body.content ?? [])
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("")
    .trim();

  if (!reply) return null;

  await appendHistory(instagramAccountId, userId, [
    { role: "user", content: text },
    { role: "assistant", content: reply },
  ]);

  return reply;
}
