FROM mcr.microsoft.com/devcontainers/base:1.2.3-ubuntu-24.04

RUN apt-get update && apt-get install -y mold \
    && curl -Lo /tmp/dotslash.tar.gz https://github.com/facebook/dotslash/releases/download/v0.4.3/dotslash-ubuntu-22.04.x86_64.v0.4.3.tar.gz \
    && echo "6268cdee662fb606e2f285a7df67da7e94815e0c96d45546c9d088482178dbbb /tmp/dotslash.tar.gz" | sha256sum -c - \
    && tar -C /usr/local/bin -vxzf /tmp/dotslash.tar.gz \
    && rm /tmp/dotslash.tar.gz
