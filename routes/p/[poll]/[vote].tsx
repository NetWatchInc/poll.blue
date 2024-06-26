import { HandlerContext } from "$fresh/server.ts";
import { getConfig } from "../../../app/config.ts";
import { getDbClient } from "../../../app/db.ts";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function vote(ipString: string, poll: string, vote: string) {
  const client = getDbClient();
  const ip = ipToInt(ipString);
  const retries = 5;
  let pollResult;
  // Retry a few times in case connection goes idle
  for (let i = 0; i < retries; i++) {
    try {
      pollResult = await client.queryObject`
      SELECT id, answers FROM polls WHERE visible_id = ${poll}`;
      break;
    } catch (e) {
      if (i === retries - 1) {
        throw e;
      }
      await sleep(100);
    }
  }
  if (!pollResult || pollResult.rows.length === 0) {
    throw new Error("Poll not found");
  }
  const { id: pollId, answers } = pollResult.rows[0] as {
    id: number;
    answers: string;
  };
  const voteNum = parseInt(vote);
  if (Number.isNaN(voteNum) || voteNum < 0 || voteNum > answers.length) {
    throw new Error("Invalid vote");
  }
  if (voteNum == 0) {
    // voteNum of 0 is just show results, don't log this as a vote!
    return
  }

  try {
    const trans = client.createTransaction("vote");
    await trans.begin();
    await trans
      .queryObject`INSERT INTO votes (ip, poll_id, vote) VALUES (${ip}, ${pollId}, ${voteNum});`;
    await trans
      .queryObject`UPDATE polls SET results = jsonb_set(results, ARRAY[${voteNum}]::text[], (COALESCE(results->(${voteNum}::integer),'0')::int + 1)::text::jsonb) WHERE id = ${pollId}::integer;`;
    await trans.commit();
  } catch {
    // Ignore duplicate votes
  }
}

function ipToInt(ip: string): number {
  return ip.split(".").map((octet, index, array) => {
    return parseInt(octet) * Math.pow(256, array.length - index - 1);
  }).reduce((prev, curr) => {
    return prev + curr;
  });
}

function getIp(req: Request): string | undefined {
  if (getConfig("ENV") === "dev") {
    // random IPv4 address
    const octets = [];
    for (let i = 0; i < 4; i++) {
      octets.push(Math.floor(Math.random() * 256));
    }
    return octets.join(".");
  }
  const hosts = req.headers?.get("x-forwarded-for")?.split(",");
  if (!hosts || hosts.length === 0) {
    return undefined;
  }
  const ip = hosts[0];
  // Stop weird ip addresses
  if (ip.startsWith("0.")) {
    return undefined;
  }
  return ip;
}

export const handler = async (
  req: Request,
  ctx: HandlerContext<{ poll: string; vote: string }>,
): Promise<Response> => {
  if (ctx.remoteAddr.transport !== "tcp") {
    return new Response("Only TCP connections are allowed", { status: 400 });
  }
  const ip = getIp(req);
  if (!ip) {
    return new Response("Missing x-forwarded-for header", { status: 400 });
  }
  await vote(ip, ctx.params.poll, ctx.params.vote);
  const response = new Response("", {
    status: 303,
    headers: { Location: `/p/${ctx.params.poll}?v=${ctx.params.vote}` },
  });
  return response;
};
