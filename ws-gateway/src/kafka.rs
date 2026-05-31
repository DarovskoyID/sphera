use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use std::time::Duration;
use tracing;

pub struct KafkaProducer {
    producer: FutureProducer,
}

impl KafkaProducer {
    pub fn new(brokers: &str) -> Self {
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("linger.ms", "5")
            .set("batch.num.messages", "1000")
            .set("compression.type", "lz4")
            .set("acks", "all")
            .set("retries", "3")
            .set("retry.backoff.ms", "100")
            .set("queue.buffering.max.messages", "100000")
            .create()
            .expect("Failed to create Kafka producer");

        Self { producer }
    }

    pub async fn publish(&self, topic: &str, key: &str, payload: &str) {
        let record = FutureRecord::to(topic)
            .key(key)
            .payload(payload);

        match self.producer.send(record, Duration::from_secs(5)).await {
            Ok(_) => {}
            Err((e, _)) => {
                tracing::error!("Kafka publish to {} failed: {}", topic, e);
            }
        }
    }
}
