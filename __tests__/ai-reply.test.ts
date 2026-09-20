import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    lrange: vi.fn(),
    multi: vi.fn(),
  },
}));

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => mockRedis,
}));

import { generateAiReply, isAiReplyEnabled, loadHistory } from "../lib/ai/reply";

/** multi() encadena y exec() resuelve, como ioredis. */
function chainableMulti() {
  const chain = {
    lpush: vi.fn(() => chain),
    ltrim: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    exec: vi.fn(async () => []),
  };
  return chain;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockRedis.lrange.mockReset();
  mockRedis.multi.mockReset();
  mockRedis.multi.mockImplementation(chainableMulti);
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("isAiReplyEnabled", () => {
  it("esta apagada sin ANTHROPIC_API_KEY, para no cambiar el comportamiento de OpenReply", () => {
    expect(isAiReplyEnabled()).toBe(false);
  });

  it("se enciende con la clave puesta", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isAiReplyEnabled()).toBe(true);
  });
});

describe("loadHistory", () => {
  it("devuelve los turnos en orden cronologico, no en el de Redis", async () => {
    // lpush deja lo mas reciente primero, asi que lrange los da al reves.
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({ role: "assistant", content: "segunda" }),
      JSON.stringify({ role: "user", content: "primera" }),
    ]);

    await expect(loadHistory("ig_1", "user_1")).resolves.toEqual([
      { role: "user", content: "primera" },
      { role: "assistant", content: "segunda" },
    ]);
  });

  it("descarta una entrada corrupta en vez de tumbar la conversacion", async () => {
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({ role: "assistant", content: "buena" }),
      "{ esto no es json",
    ]);

    await expect(loadHistory("ig_1", "user_1")).resolves.toEqual([
      { role: "assistant", content: "buena" },
    ]);
  });
});

describe("generateAiReply", () => {
  it("no llama a la API si la IA esta apagada", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      generateAiReply({ instagramAccountId: "ig_1", userId: "u_1", text: "hola" })
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no llama a la API con un mensaje en blanco", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      generateAiReply({ instagramAccountId: "ig_1", userId: "u_1", text: "   " })
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("manda el historial por delante del mensaje nuevo y guarda los dos turnos", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({ role: "assistant", content: "Dime" }),
      JSON.stringify({ role: "user", content: "Buenas" }),
    ]);
    const chain = chainableMulti();
    mockRedis.multi.mockReturnValue(chain);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "Claro que si" }] }),
        { status: 200 }
      )
    );

    await expect(
      generateAiReply({
        instagramAccountId: "ig_1",
        userId: "u_1",
        text: "Cuanto cuesta?",
      })
    ).resolves.toBe("Claro que si");

    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.messages).toEqual([
      { role: "user", content: "Buenas" },
      { role: "assistant", content: "Dime" },
      { role: "user", content: "Cuanto cuesta?" },
    ]);
    // El turno del cliente y el de la IA se guardan juntos.
    expect(chain.lpush).toHaveBeenCalledOnce();
    expect(chain.expire).toHaveBeenCalledWith(expect.any(String), 24 * 60 * 60);
  });

  it("devuelve null, y no guarda nada, si el modelo no da texto", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockRedis.lrange.mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: [] }), { status: 200 })
    );

    await expect(
      generateAiReply({ instagramAccountId: "ig_1", userId: "u_1", text: "hola" })
    ).resolves.toBeNull();
    expect(mockRedis.multi).not.toHaveBeenCalled();
  });

  it("lanza si la API responde con error, para que el worker lo registre", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    mockRedis.lrange.mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 })
    );

    await expect(
      generateAiReply({ instagramAccountId: "ig_1", userId: "u_1", text: "hola" })
    ).rejects.toThrow(/429/);
  });
});
