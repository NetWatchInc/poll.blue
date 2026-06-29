import { AtpAgent } from "@atproto/api";
import { config, botEnabled } from "./config.ts";
import { query, type DbPoll } from "./db.ts";
import { generateBotPollText, generateId, generateResultsText, parseMention } from "./poll-text.ts";

let agent: AtpAgent | undefined;
// post_uri -> expiry (ms). Avoids re-processing the same mention repeatedly.
const seen = new Map<string, number>();
const SEEN_TTL = 1000 * 60 * 60 * 24;

export async function startBot(): Promise<void> {
  if (!botEnabled) {
    console.log("Bot disabled (no Bluesky credentials) — like/repost and result posting are off.");
    return;
  }
  try {
    agent = new AtpAgent({ service: config.BSKY_HOST });
    await agent.login({ identifier: config.BSKY_USERNAME, password: config.BSKY_PASSWORD });
    console.log(`Bot logged in as @${agent.session?.handle}`);
  } catch (e) {
    console.error("Bot failed to log in — continuing without it:", e);
    agent = undefined;
    return;
  }
  const tick = async () => {
    try {
      await postResults();
      await postLegacyPolls();
    } catch (e) {
      console.error("bot job error:", e);
    }
  };
  await tick();
  setInterval(tick, 10_000);
}

// Bot like + repost of a freshly-registered (OAuth) poll post.
export async function likeRepost(postUri: string, cid: string): Promise<void> {
  if (!agent) return;
  const repo = agent.session?.did;
  const createdAt = new Date().toISOString();
  const subject = { uri: postUri, cid };
  await Promise.all([
    agent.app.bsky.feed.like.create({ repo }, { subject, createdAt }),
    agent.app.bsky.feed.repost.create({ repo }, { subject, createdAt }),
  ]);
}

async function postResults(): Promise<void> {
  const polls = await query<DbPoll>(
    `SELECT * FROM polls WHERE results_posted = false AND created_at < NOW() - INTERVAL '24 hours'`,
  );
  if (polls.rows.length === 0) return;
  await query(`UPDATE polls SET results_posted = true WHERE id = ANY($1)`, [polls.rows.map((p) => p.id)]);

  for (const poll of polls.rows) {
    if (!poll.post_uri) continue;
    try {
      const resp = await agent!.app.bsky.feed.getPostThread({ uri: poll.post_uri });
      // deno-lint-ignore no-explicit-any
      const thread = resp.data.thread as any;
      if (!thread?.post) continue;
      const ref = { uri: thread.post.uri, cid: thread.post.cid };
      await agent!.app.bsky.feed.post.create(
        { repo: agent!.session?.did },
        {
          text: generateResultsText(poll.question, poll.answers, poll.results),
          reply: { parent: ref, root: ref },
          createdAt: new Date().toISOString(),
        },
      );
    } catch (e) {
      console.error(`failed to post results for poll ${poll.id}:`, e);
    }
  }
}

async function postLegacyPolls(): Promise<void> {
  const notifs = await agent!.app.bsky.notification.listNotifications({ limit: 50 });
  for (const notif of notifs.data.notifications) {
    if (notif.reason !== "mention") continue;
    // deno-lint-ignore no-explicit-any
    const record = notif.record as any;
    const text: string | undefined = record?.text;
    if (!text || text.startsWith(config.BSKY_USERNAME)) continue;
    if (!(await isRelevant(notif.uri))) continue;

    const poll = parseMention(text);
    if (!poll) continue;
    const replyRef = {
      parent: { uri: notif.uri, cid: notif.cid },
      root: record?.reply?.root ?? { uri: notif.uri, cid: notif.cid },
    };
    try {
      await postPoll(poll, replyRef, notif.author.handle);
    } catch (e) {
      console.error("failed to post poll from mention:", e);
    }
  }
}

async function isRelevant(postUri: string): Promise<boolean> {
  const now = Date.now();
  const exp = seen.get(postUri);
  if (exp && exp > now) return false;
  const existing = await query(`SELECT 1 FROM polls WHERE post_uri = $1`, [postUri]);
  if (existing.rows.length > 0) {
    seen.set(postUri, now + SEEN_TTL);
    return false;
  }
  return true;
}

interface ReplyRef {
  parent: { uri: string; cid: string };
  root: { uri: string; cid: string };
}

async function postPoll(
  poll: ReturnType<typeof parseMention> & object,
  replyRef: ReplyRef,
  author: string,
): Promise<void> {
  const visibleId = generateId(6);
  const results = poll.answers.map(() => 0).concat([0]);
  const postUri = replyRef.parent.uri;
  const postId = postUri.split("/").slice(-1)[0];

  await query(
    `INSERT INTO polls (posted_by, post_uri, question, answers, results, visible_id, results_posted, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [author, postUri, poll.question, JSON.stringify(poll.answers), JSON.stringify(results), visibleId, false, "poll.blue-bot"],
  );
  seen.set(postUri, Date.now() + SEEN_TTL);

  const { text, links, pollFacets } = generateBotPollText({ visibleId, poll, author, postId });
  const createdAt = new Date().toISOString();
  await Promise.all([
    agent!.app.bsky.feed.post.create(
      { repo: agent!.session?.did },
      // custom blue.poll.* facets aren't in the standard lexicon types
      // deno-lint-ignore no-explicit-any
      { text, reply: replyRef, facets: [...links, ...pollFacets], createdAt } as any,
    ),
    agent!.app.bsky.feed.like.create(
      { repo: agent!.session?.did },
      { subject: { uri: replyRef.parent.uri, cid: replyRef.parent.cid }, createdAt },
    ),
  ]);
  console.log(`posted poll ${visibleId} from @${author}`);
}
