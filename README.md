# luci-proto-modemmanager-fix

重做 **ModemManager 的 LuCI 蜂窝网络信息页**，并修复
**移远模组的拨号问题**（开机自动拨号 + 掉线自动恢复）。以「编译期替换上游
`luci-proto-modemmanager`」的方式提供，独立于 QModem 仓库。

## 目录结构

```
luci-proto-modemmanager-fix/     应用包源码（即 OpenWrt feed 里的包目录）
├── Makefile                     PROVIDES/CONFLICTS=luci-proto-modemmanager，PKG_LICENSE:=GPL-2.0
├── README.md                    包级说明：信息页内容、拨号修复、安装、文件清单、验证状态、许可
├── htdocs/luci-static/resources/
│   ├── view/modemmanager/status.js    信息页（QModem 风格面板）
│   ├── modemmanager_helper.js         数据层（mmcli -L/-m/-i/-b/--signal-get）
│   └── protocol/modemmanager.js       接口编辑表单（上游原样，保证替换后仍可编辑）
└── root/
    ├── etc/init.d/wan-mm-wait                看护：开机拨号 + 掉线自动恢复
    ├── etc/uci-defaults/99-wan-mm-wait       补齐 auto / force_connection，启用看护
    ├── usr/share/luci/menu.d/luci-proto-modemmanager.json
    └── usr/share/rpcd/acl.d/luci-proto-modemmanager.json

patches/modemmanager/            调研产物，不打包进固件
├── 0100-quectel-qeng-3gpp-location.patch   改用 AT+QENG 取小区位置的插件补丁（功能可用但会崩溃，未采用）
├── tools/mbimprobe.c                       只读 MBIM 探针（结论：该模组未声明 QDU/ATDS，MBIM-AT 通道不可用）
└── README.md                               调研结论与复现步骤
```

本项目根目录**同时就是 feed 根**：`src-link` 直接指向它即可。

## 快速开始（编译进固件）

```sh
# 1) 把本项目作为 feed 加入构建树
echo "src-link mmfix /home/aya/luci-proto-modemmanager-fix" >> feeds.conf
./scripts/feeds update -a && ./scripts/feeds install -a

# 2) 选中本包、取消上游原包（两者互斥）
echo "CONFIG_PACKAGE_luci-proto-modemmanager-fix=m" >> .config
echo "CONFIG_PACKAGE_luci-proto-modemmanager=n" >> .config

# 3) 编译
make defconfig && make
```

依赖原包名的其它组件不受影响（ACL 组名仍沿用 `luci-proto-modemmanager`）。
若不想用 CONFLICTS/PROVIDES，也可以把包内文件按相同路径直接打进上游包。

## 它解决什么问题

| 问题 | 本项目的做法 |
| --- | --- |
| 上游信息页信息量少、字段平铺 | 换成 QModem 风格的折叠/可拖动面板，数值与进度条并排，空值自动隐藏 |
| 上游缺承载明细与 SIM 详情 | 新增 Bearer 面板（APN/地址/网关/DNS/MTU/速率/时长）与更完整的 SIM 面板 |
| 开机不拨号：`network`(S20) 早于 `modemmanager`(S70)，处理器失败后不重试 | 看护脚本 `wan-mm-wait` 等模组就绪后 `ifup` |
| 掉线不恢复：接口被拆后无人重拨（实测断了 5 分钟） | 同一看护每 30 秒巡检并拉起（实测 55 秒自愈） |
| LuCI 保存接口会丢掉 `option auto` | `uci-defaults` 补回 `auto=1` |
| 连接失败走 `proto_block_restart` 拒绝重启 | `uci-defaults` 设置 `force_connection=1` |
| 小区位置/扩展信号显示为空 | 直接不显示（原因见包内 README 与 `patches/`） |

详细信息见包内 `luci-proto-modemmanager-fix/README.md`。

## 验证状态

- 在 OpenWrt 25.12.5 SDK（x86_64/musl）上编译通过，产物
  `luci-proto-modemmanager-fix-1.0.0-r1.apk`，包内 7 个安装文件路径正确。
- 真机（iStoreOS 25.12.5 + Quectel RM500U-CNV）验证：页面取数与渲染逻辑、
  6 类 mmcli 命令经 rpcd ACL 放行、看护的故障自愈（`ifdown wan` 后 55 秒恢复）。
- 页面 DOM/CSS 外观未经浏览器验证（无浏览器环境），JS 仅做语法与渲染逻辑校验。

## 许可证

本项目以 **GNU 通用公共许可证第 2 版（GPLv2）** 授权发布，包元数据声明为
`PKG_LICENSE:=GPL-2.0`。其中 `htdocs/luci-static/resources/protocol/modemmanager.js`
取自上游 LuCI 包 `luci-proto-modemmanager`（Apache-2.0），保留其原始许可；
本项目其余部分按 GPLv2 授权。许可证全文见 GNU 官方：
<https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>
