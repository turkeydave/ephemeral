// pubsub-relay
//
// Pulls messages from a Pub/Sub topic (via the emulator) and POSTs each one
// to the API as a GCP Pub/Sub *push* envelope. This lets us develop the
// receiving HTTP endpoint exactly the way it'll be called in production
// (where Pub/Sub will push directly), without needing the emulator to
// support push subscriptions.

const { PubSub } = require('@google-cloud/pubsub');

const PROJECT_ID    = process.env.GCLOUD_PROJECT   || 'demo-project';
const TOPIC_NAME    = process.env.PUBSUB_TOPIC     || 'taskHistory';
const SUB_NAME      = process.env.PUBSUB_SUBSCRIPTION || 'taskHistory-relay-sub';
const PUSH_URL      = process.env.PUSH_URL         || 'http://api:3001/events/task-history';
const ACK_DEADLINE  = parseInt(process.env.ACK_DEADLINE_SECONDS || '30', 10);

async function ensureTopicAndSubscription(pubsub) {
  const topic = pubsub.topic(TOPIC_NAME);
  const [topicExists] = await topic.exists();
  if (!topicExists) {
    await pubsub.createTopic(TOPIC_NAME);
    console.log(`relay: created topic ${TOPIC_NAME}`);
  }
  const subscription = topic.subscription(SUB_NAME);
  const [subExists] = await subscription.exists();
  if (!subExists) {
    await topic.createSubscription(SUB_NAME, { ackDeadlineSeconds: ACK_DEADLINE });
    console.log(`relay: created subscription ${SUB_NAME}`);
  }
  return subscription;
}

async function relay(message) {
  // Mirror the GCP Pub/Sub push envelope so the API endpoint can be reused
  // unchanged in production.
  const envelope = {
    message: {
      data: message.data.toString('base64'),
      attributes: message.attributes || {},
      messageId: message.id,
      publishTime: message.publishTime
        ? message.publishTime.toISOString()
        : new Date().toISOString(),
    },
    subscription: `projects/${PROJECT_ID}/subscriptions/${SUB_NAME}`,
  };

  const res = await fetch(PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (res.status >= 200 && res.status < 300) {
    message.ack();
    console.log(`relay: pushed msg ${message.id} → ${res.status}`);
  } else {
    const body = await res.text().catch(() => '');
    console.error(`relay: push failed ${res.status}: ${body}`);
    message.nack(); // pubsub will redeliver
  }
}

async function main() {
  console.log(`relay: PUBSUB_EMULATOR_HOST=${process.env.PUBSUB_EMULATOR_HOST || '(unset)'}`);
  console.log(`relay: project=${PROJECT_ID} topic=${TOPIC_NAME} sub=${SUB_NAME} push=${PUSH_URL}`);

  const pubsub = new PubSub({ projectId: PROJECT_ID });

  // Retry topic/subscription setup until pubsub emulator is ready.
  let subscription;
  for (let attempt = 1; ; attempt++) {
    try {
      subscription = await ensureTopicAndSubscription(pubsub);
      break;
    } catch (err) {
      console.error(`relay: setup attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  subscription.on('message', (msg) => {
    relay(msg).catch((err) => {
      console.error('relay: unexpected error in handler:', err);
      try { msg.nack(); } catch {}
    });
  });
  subscription.on('error', (err) => {
    console.error('relay: subscription error:', err.message);
  });

  console.log(`relay: listening on subscription ${SUB_NAME}`);
}

main().catch((err) => {
  console.error('relay: fatal:', err);
  process.exit(1);
});
