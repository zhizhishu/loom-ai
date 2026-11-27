# Loom Node（Windows 小包）

这个 zip 只做一件事：让一台 Windows 机器作为执行节点，主动外连你已经跑起来的 Loom Server。
节点只发起出站 WebSocket 连接，不监听任何入站端口。

## 包内容

| 文件 | 用途 |
| --- | --- |
| `loom-node.exe` | 节点程序，外连 Server 的 `/api/v1/nodes/connect` |
| `Connect-LoomNode.ps1` | 连接 / 重连脚本，读取配对码并前台启动 `loom-node.exe` |
| `README.md` | 本文件 |

包里没有 Server、Web UI、Pi runtime 或 computer helper；解压后请让这三个文件保持在同一目录。

## 首次配对（只需要一次）

1. 在 Server 上取一个一次性配对码（短时有效、只能用一次）：
   `rovai-server node-pair --data-dir <Server 数据目录>`，它会在 stdout 打印配对码，并在 stderr 打印 `connect:` 地址。
2. 在节点机上运行脚本，把 `connect:` 地址原样传给 `-Server`：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Connect-LoomNode.ps1 -Server wss://<Server 地址>/api/v1/nodes/connect
   ```

   看到 `One-time pairing code` 提示时粘贴配对码（输入不回显）。

配对成功后由 `loom-node` 自己把节点凭据写到 `<DataDir>\node.json`；脚本不保存配对码。

脚本也支持非交互：标准输入被重定向时，它只读第一行当配对码。同机示例：

```powershell
rovai-server node-pair --data-dir C:\loom-server | powershell -NoProfile -ExecutionPolicy Bypass -File .\Connect-LoomNode.ps1 -Server ws://127.0.0.1:8767/api/v1/nodes/connect
```

注意：不要把配对码写进命令行（有的 shell 会把命令行记进历史）。

## 二次重连

`<DataDir>\node.json` 已存在时，脚本直接重连，不再要求配对码：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Connect-LoomNode.ps1 -Server wss://<Server 地址>/api/v1/nodes/connect
```

这时传给 `loom-node.exe` 的参数只有 `--data-dir` 和 `--server`。

## 配对码的传递

- 只从两处读：交互式隐藏输入（`Read-Host -AsSecureString`），或标准输入的第一行。
- 交给节点时只用 `--pair-code-stdin` 走标准输入；配对码不会出现在命令行参数、环境变量、文件或日志里。
- 脚本不把配对码写盘；磁盘上只有 `loom-node` 自己写的 `node.json` 节点凭据。
- `ws://` 明文只允许 loopback（`localhost`、`127.0.0.1`、`::1`）；远程 Server 必须用 `wss://`。
- `-Server` 必须是 `ws://` / `wss://` 绝对地址且路径以 `/api/v1/nodes/connect` 结尾；空配对码、非 loopback 的明文 `ws://` 都会被脚本直接拒绝（退出码非 0）。

## 数据目录与退出

- 默认数据目录是 `%LOCALAPPDATA%\LoomNode`，也可以用 `-DataDir <目录>` 指定；目录不存在时脚本会创建。
- 脚本在前台运行：不退到后台、不自动重试、不注册 Windows 服务。断线后重新运行一次即可。
- `loom-node.exe` 的退出码由脚本原样返回，方便放进别的批处理里判断。
