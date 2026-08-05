# Create a Bot on the Feishu Open Platform

https://open.feishu.cn/

## Step 1: Create a Bot on the Feishu Open Platform

1. Log in to the Feishu Open Platform.
2. Click **Create Custom App**, select **Enterprise Self-built App**, and give it a name.
3. Navigate to **Credentials & Basic Info** to find and copy your **App ID** and **App Secret**.
4. Go to **Features > Add Features** and enable the **Bot** capability.

## Step 2: Configure Required Permissions & Events

Your bot must have permissions to listen and talk inside chats.

### Enable API Permissions

Go to **Permissions**, search for, and enable the following:

- `im:message` — Send and receive messages
- `im:chat` — Get group chat information
- `contact:user.base:readonly` — Read basic user profile info

### Configure Event Subscription

1. Go to **Events & Callbacks**.
2. Switch the connection mode to **Long Connection (WebSocket)**.
3. Click **Add Event** and subscribe to **Receive Message V1** (`im.message.receive_v1`).

## Step 3: Release the Bot App

1. Go to **App Versions > Version Management & Release**.
2. Click **Create Version**, fill in the basic version details, and click **Save**.
3. Click **Submit for Release**.

> **Note:** The app must be approved by your organization's Feishu administrator before it activates.

---

# 在飞书开放平台创建机器人

https://open.feishu.cn/

## 步骤 1：在飞书开放平台创建机器人

1. 登录飞书开放平台。
2. 点击 **创建企业自建应用**（Create Custom App），选择 **企业自建应用**（Enterprise Self-built App）并填写名称。
3. 进入 **凭证与基础信息**（Credentials & Basic Info），找到并复制 **App ID** 和 **App Secret**。
4. 进入 **添加应用能力**（Features > Add Features），启用 **机器人**（Bot）能力。

## 步骤 2：配置所需权限与事件

机器人必须拥有在会话中收发消息的权限。

### 开通 API 权限

进入 **权限管理**（Permissions），搜索并开通以下权限：

- `im:message` — 收发消息
- `im:chat` — 获取群组信息
- `contact:user.base:readonly` — 读取用户基本信息

### 配置事件订阅

1. 进入 **事件与回调**（Events & Callbacks）。
2. 将连接方式切换为 **长连接**（Long Connection / WebSocket）。
3. 点击 **添加事件**（Add Event），订阅 **接收消息 V1**（`im.message.receive_v1`）。

## 步骤 3：发布机器人应用

1. 进入 **版本管理与发布**（App Versions > Version Management & Release）。
2. 点击 **创建版本**（Create Version），填写版本基本信息后点击 **保存**（Save）。
3. 点击 **申请发布**（Submit for Release）。

> **注意：** 应用需经企业飞书管理员审批通过后才会生效。
