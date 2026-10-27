# 一个 CLI，多个 Provider

通过队员环境变量，为不同队员配置各自的 API 地址和密钥。同一份 CLI 安装，就能让队员同时连接不同的模型服务。下面以 Claude Code 为例，接入 Provider A 和 Provider B。

![同一份 Claude Code 安装供两位队员使用，队员 A 连接 Provider A，队员 B 连接 Provider B。](https://rovai.dev/assets/diagrams/multiple-providers-zh.svg)

每位队员分别运行 Claude Code，启动时读取自己的环境变量。Provider 是提供模型 API 的服务或网关。

## 1. 准备两位队员 {#prepare-teammates}

在「队员」中创建**队员 A** 和**队员 B**。分别打开「运行配置」，两位队员都选择 **Claude Code**，模型选择对应 Provider 支持的模型。

## 2. 填写各自的环境变量 {#environment}

展开每位队员运行配置中的「**环境变量**」，粘贴对应的 JSON。将地址和密钥替换为各服务提供的 Claude Code 接入配置，然后分别保存。

下面的 `.example` 地址为占位地址。密钥直接填写原始值，无需添加 `Bearer ` 前缀。

### 队员 A → Provider A

```json
{
  "ANTHROPIC_BASE_URL": "https://provider-a.example",
  "ANTHROPIC_AUTH_TOKEN": "YOUR_PROVIDER_A_KEY"
}
```

### 队员 B → Provider B

```json
{
  "ANTHROPIC_BASE_URL": "https://provider-b.example",
  "ANTHROPIC_AUTH_TOKEN": "YOUR_PROVIDER_B_KEY"
}
```

- `ANTHROPIC_BASE_URL`：服务提供的 Claude Code API 基础地址，按接入说明保留所需路径。
- `ANTHROPIC_AUTH_TOKEN`：这位队员使用的服务密钥，以 Bearer Token 方式发送。

## 3. 验证两条连接 {#verify-connections}

1. 将配置好的两位队员加入一个新对话。
2. 分别向两位队员发送简单消息，例如「**请回复：连接成功，不调用工具。**」，确认都能正常回复。
3. 在 Provider A 和 Provider B 的控制台或服务日志中，分别核对刚才的请求，确认各自走了预期的服务。

连接确认后，两位队员就可以在同一个对话中协作。每位队员保留自己的配置，无需来回切换全局 Provider。

回复文字只能说明请求成功；判断用了哪个 Provider，应以对应服务的请求记录为准。

## 常见问题 {#questions}

### 已经运行过的队员，修改后何时生效？

环境变量在新启动 Claude Code 进程时读取。保存配置不会切换已启动进程的连接；发送下一条消息也可能继续复用原进程。进程退出或 Rovai 重启后，新启动的进程会使用当前配置。

### 会修改其他队员或本机的 Claude Code 配置吗？

这里保存的是当前主机上、当前队员的 Claude Code 环境变量。Rovai 在启动该队员时应用它，不会改写其他队员的配置，也不会把它写回 Claude Code 的全局配置文件。

### 其他智能体也能这样使用吗？

队员环境变量入口可用于其他智能体，但支持哪些变量、如何选择 Provider 和模型，由各自的 CLI 决定。本文示例适用于 Claude Code；为其他智能体配置时，请使用它们自己的变量。

## 官方参考（外链） {#references}

- [Claude Code 环境变量参考](https://code.claude.com/docs/en/env-vars)
- [Claude Code 认证方式](https://code.claude.com/docs/en/authentication)
