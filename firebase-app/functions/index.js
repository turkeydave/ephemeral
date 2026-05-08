const functions = require('firebase-functions/v1');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { PubSub } = require('@google-cloud/pubsub');

initializeApp();
const db = getFirestore();

// PubSub client. When PUBSUB_EMULATOR_HOST is set, the SDK targets the emulator
// and the projectId can be anything — keep it consistent with the rest of POC.
const pubsub = new PubSub({ projectId: process.env.GCLOUD_PROJECT || 'demo-project' });
const TOPIC_NAME = 'taskHistory';

let topicReadyPromise = null;
function getTopic() {
  if (!topicReadyPromise) {
    topicReadyPromise = (async () => {
      const topic = pubsub.topic(TOPIC_NAME);
      const [exists] = await topic.exists();
      if (!exists) {
        await pubsub.createTopic(TOPIC_NAME);
        console.log(`pubsub: created topic ${TOPIC_NAME}`);
      }
      return topic;
    })().catch((err) => {
      // Reset so a later invocation can retry.
      topicReadyPromise = null;
      throw err;
    });
  }
  return topicReadyPromise;
}

// Trigger: on any write (create, update, delete) of `tasks/{taskId}`.
// 1) Persist a history record to Firestore `taskHistory`.
// 2) Publish a Pub/Sub event so external consumers (e.g. the postgres
//    replicator) can subscribe — this mirrors the GCP push-subscription
//    pattern we'll use in production.
exports.onTaskWrite = functions.firestore
  .document('tasks/{taskId}')
  .onWrite(async (change, context) => {
    const before = change.before.exists ? change.before.data() : null;
    const after = change.after.exists ? change.after.data() : null;
    const taskId = context.params.taskId;
    const op = !before ? 'create' : !after ? 'delete' : 'update';

    const event = {
      taskId,
      op,
      before: before || {},
      after: after || {},
      occurredAt: new Date().toISOString(),
    };

    // 1) Firestore write
    await db.collection('taskHistory').add({
      ...event,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 2) Pub/Sub publish — best-effort so the trigger doesn't fail if pubsub
    // is unavailable; the firestore record is the source of truth.
    try {
      const topic = await getTopic();
      const messageId = await topic.publishMessage({
        json: event,
        attributes: { taskId, op },
      });
      console.log(`pubsub: published ${messageId} (taskId=${taskId} op=${op})`);
    } catch (err) {
      console.error('pubsub: publish failed (non-fatal):', err.message);
    }

    return null;
  });
