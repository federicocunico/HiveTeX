# Router matrix lab (13.4): Linux namespaces with NAT, miniupnpd, coturn and tcpdump, plus what the desktop crate
# needs to build its native peer (rtc_cli). Local use (Docker Desktop):
#   docker build -t hivetex-netlab apps/desktop/e2e/netlab
#   docker run --rm --privileged -v "$PWD:/src" -v hivetex-netlab-target:/target hivetex-netlab
FROM rust:1.93-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev pkg-config \
      iproute2 iptables nftables miniupnpd-nftables coturn tcpdump iputils-ping nodejs \
  && rm -rf /var/lib/apt/lists/*
ENV CARGO_TARGET_DIR=/target
WORKDIR /src
CMD ["sh", "apps/desktop/e2e/netlab/run.sh"]
