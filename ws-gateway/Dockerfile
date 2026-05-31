FROM rust:1.82-slim-bookworm AS builder

RUN apt-get update && apt-get install -y cmake pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/ionik-ws-gateway /usr/local/bin/

ENV RUST_LOG=info
EXPOSE 8001

CMD ["ionik-ws-gateway"]
