# 已核实的技术事实

2026-11-12 读取本地 package.json、components.json、官方 registry 及官方文档地址。当前项目是 shadcn base-nova + @base-ui/react ^1.9.0（非 Radix/Vaul），Tailwind v4，无 preflight，组件源码位于 web/src/mobile/components/ui。

官方依据：
- https://ui.shadcn.com/docs/components/base/select
- https://ui.shadcn.com/docs/components/base/input-group
- https://ui.shadcn.com/docs/components/base/toggle-group
- https://ui.shadcn.com/docs/components/base/tabs
- https://ui.shadcn.com/r/styles/base-nova/select.json （及同路径 tabs/input-group/toggle-group）

本环境无 WebSearch 工具；用官方 shadcn docs CLI 与 Python HTTPS 直接读取一手资源核实，不凭记忆假设 API。CLI 默认远端 registry TLS 读取失败，官方 JSON 通过 Python HTTPS 读取成功；后续安装保留官方源码来源。
