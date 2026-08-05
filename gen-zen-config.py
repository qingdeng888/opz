"""
gen-zen-config.py — 从机场订阅生成独立的 mihomo 配置
独立实例端口: 代理 17897 / API 19090,与 Clash Verge 完全隔离。
"""
import sys
import urllib.request
import yaml
from pathlib import Path

SUB_URL = "你的机场订阅链接"  # 替换为你的 Clash 订阅 URL
OUT_CONFIG = Path(__file__).parent / "mihomo-zen.yaml"

MIXED_PORT = 17897
CTRL_PORT = 19090


def fetch_subscription(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "clash-verge/v2.5"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read().decode("utf-8")
    return yaml.safe_load(data)


def build_config(sub: dict) -> dict:
    proxies = sub.get("proxies") or []
    if not proxies:
        raise RuntimeError("订阅里没有 proxies")

    # 过滤掉内置类型,只保留真实节点
    real_nodes = []
    node_names = []
    for p in proxies:
        name = p.get("name")
        ptype = p.get("type")
        if not name or ptype in (None, "Direct", "Reject", "Pass", "Compatible"):
            continue
        real_nodes.append(p)
        node_names.append(name)

    if not real_nodes:
        raise RuntimeError("没有可用的真实节点")

    cfg = {
        "mixed-port": MIXED_PORT,
        "allow-lan": False,
        "bind-address": "*",
        "mode": "rule",
        "log-level": "warning",
        "external-controller": f"127.0.0.1:{CTRL_PORT}",
        "ipv6": False,
        "tcp-concurrent": True,
        "unified-delay": True,
        # 不开 tun,不动系统代理
        "tun": {"enable": False},
        # 简单 DNS,避免 fake-ip 干扰
        "dns": {
            "enable": True,
            "ipv6": False,
            "enhanced-mode": "redir-host",
            "nameserver": ["223.5.5.5", "119.29.29.29"],
            "fallback": ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"],
        },
        "proxies": real_nodes,
        "proxy-groups": [
            {
                "name": "zen-pool",
                "type": "select",
                "proxies": node_names,
            },
            {
                "name": "zen-auto",
                "type": "url-test",
                "url": "http://www.gstatic.com/generate_204",
                "interval": 300,
                "tolerance": 50,
                "proxies": node_names,
            },
        ],
        "rules": [
            # opencode.ai 走节点池,其他全部直连(不影响其他流量)
            "DOMAIN-SUFFIX,opencode.ai,zen-pool",
            "MATCH,DIRECT",
        ],
    }
    return cfg


def main() -> int:
    print(f"[1/3] 拉取订阅: {SUB_URL}")
    sub = fetch_subscription(SUB_URL)
    print(f"    订阅 proxies 数量: {len(sub.get('proxies') or [])}")

    print("[2/3] 生成独立配置")
    cfg = build_config(sub)
    real_count = len(cfg["proxies"])
    print(f"    有效节点: {real_count}")
    print(f"    mixed-port: {cfg['mixed-port']}")
    print(f"    external-controller: {cfg['external-controller']}")

    print(f"[3/3] 写入: {OUT_CONFIG}")
    with open(OUT_CONFIG, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
