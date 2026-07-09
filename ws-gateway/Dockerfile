FROM rust:1-slim-bookworm AS builder

# rdkafka-sys собирает librdkafka из исходников (фича cmake-build), поэтому нужен
# полный набор инструментов и dev-заголовков опциональных библиотек, которые
# подтягивает librdkafka (ssl, sasl, curl/oidc, zlib, lz4, zstd).
RUN apt-get update && apt-get install -y \
        build-essential \
        cmake \
        pkg-config \
        git \
        libssl-dev \
        libsasl2-dev \
        libcurl4-openssl-dev \
        zlib1g-dev \
        liblz4-dev \
        libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim
# Рантайм-библиотеки, на которые динамически линкуется статически собранная
# librdkafka (curl, sasl, ssl, zlib, lz4, zstd).
RUN apt-get update && apt-get install -y \
        ca-certificates \
        libssl3 \
        libsasl2-2 \
        libcurl4 \
        zlib1g \
        liblz4-1 \
        libzstd1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/sfera-ws-gateway /usr/local/bin/

ENV RUST_LOG=info
EXPOSE 8001

CMD ["sfera-ws-gateway"]
