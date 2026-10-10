# 香色闺阁书源

将「[开源阅读 Legado](https://github.com/gedoor/legado)」书源转换为「香色闺阁 XSGG」书源的开源工具，提供格式识别、批量转换、JSON / XBS 导入导出，以及可选的域名检查、真实网站检测和修复候选。

**以确定性规则为核心，真实网站证据为辅助，AI 作为可选兜底。普通转换无需 API Key。**

本项目基于 **[ljun223/legado2xsgg](https://github.com/ljun223/legado2xsgg)** 扩展，保留原项目的转换引擎、提交历史、Android 工具代码及 MIT 许可证。README 的组织方式参考了[上游说明](https://github.com/ljun223/legado2xsgg/blob/main/README.md)。感谢原作者 ljun223 的开源贡献。

> 当前为持续完善中的开发版本，主要面向香色闺阁 StandarReader 2.56.1 的书源格式。格式合法、联网检测通过与官方 iOS App 实测是不同的验证阶段；转换结果仍需在目标 App 中确认。

## 功能

- **自动识别格式**：Legado 单对象 / 数组、XSGG 单源 / 别名包装 / 多源、混合输入和多段连续 JSON。
- **确定性转换**：将可支持的 Default / CSS 等规则转换为 XPath，处理模板、请求配置、分类和常见 JavaScript 映射。
- **JSON / XBS 工具**：导入、查看、编辑、单源及批量导出，提供 XBS 与 JSON 双向转换。
- **域名检查**：记录跳转链，区分永久跳转、临时跳转、跨域迁移和路径变化；检查可关闭。
- **真实网站检测**：在服务端允许的网络范围内，检查搜索、详情、目录和正文，展示 HTTP 与规则提取证据。
- **修复候选**：基于证据生成差异，使用修复后的 XSGG 配置再次检查，保留原始输入。
- **可选 AI 分析**：支持自定义接口地址、API Key、模型和高级参数；默认转换不调用 AI。
- **简洁工作台**：侧边导航、转换预览、诊断、下载和更新记录。

### 规则兼容范围

| 类型 | 当前处理方式与限制 |
| --- | --- |
| DefaultRule / CSS | 支持常见选择器、文本 / HTML / 属性提取及部分索引、排除、组合；复杂语法可能降级并给出诊断 |
| XPath | 保留已有表达式，处理可识别的列表上下文；提取正确性仍需实际页面验证 |
| JSONPath | 支持识别及部分格式兼容；复杂表达式和 HTML ↔ JSON 混合流程尚不能保证等价转换 |
| JavaScript | 支持部分 `java.*` 映射、`@js:` / `<js>` 和可静态提取的 `jsLib` 辅助函数；无法映射的宿主 API 会提示 |
| 模板与 URL | 处理常见 `{{key}}`、`{{page}}`、内嵌规则及相对地址；复杂动态表达式可能需要人工确认 |
| HTTP 请求 | 支持常见 GET / POST、请求头和部分编码；特殊请求体、认证及动态请求不能保证兼容 |
| 分类与分页 | 支持部分静态分类提取、筛选参数和分页规则；复杂动态分类与多页正文需 App 实测 |
| WebView / 登录 / 验证码 | 无法通过静态检测证明可用，保留限制诊断，可能需要人工或 App 实测 |

引擎输出兼容性诊断，区分可等价处理、部分支持和无法安全转换。不要把输出书源数量理解为可用书源数量，也不要通过凭空生成目录 / 正文规则来掩盖失败。

转换与网站检测不会执行上传书源中的不可信 JavaScript。浏览器界面自身脚本与生成给目标 App 的规则脚本属于不同环节。

### 域名检查与安全

自动迁移采取保守策略：永久跳转不等于整条书源已经迁移成功。路径或接口变化、临时跳转、全新域名和动态脚本中的地址可能需要确认及额外验证。

仅修改有证据支持的 URL 字段；Cookie、Token、正文及无关 CDN 地址不应作为普通域名替换对象。服务端限制请求超时、跳转和响应体，并对目标及每次跳转进行网络安全检查，拒绝内网、回环和元数据地址。

部分真实网站检测受 `server/data/site-allowlist.json` 限制。部署者应按自己的网络策略维护允许范围，不要把服务配置成开放代理。

## 使用说明

1. 粘贴或上传自己的 Legado / XSGG 书源；也可在 XBS 工具中导入 XBS 文件。
2. 查看格式识别、转换结果及每条书源的兼容性诊断。
3. 如启用联网检查，查看网站状态、跳转链和字段提取证据。
4. 检查修复候选的字段差异与再次验证结果。
5. 下载 JSON 或 XBS，并在香色闺阁中导入和实测。

AI 分析为可选功能。需要时再设置接口与模型；无需为正常规则转换填写 API Key 或错误描述。

### 状态如何理解

| 状态 | 含义 |
| --- | --- |
| 格式通过 | 结构检查通过，不代表网站可访问或规则能提取数据 |
| 联网检测通过 | 当前服务器、关键词与静态检测条件下取得了相应证据 |
| 修复候选 | 存在建议修改，应检查差异与二次验证 |
| 网站不可达 | 可能是网络、超时、HTTP 错误或站点限制，需要看具体证据 |
| 需要人工确认 | 自动处理缺少充分依据，或遇到动态流程 |
| 需要 App 实测 | 最终行为须在官方 iOS App 验证，服务端无法代替 |

## 本地运行

推荐 **Node.js 24**。生成浏览器 bundle 需要 Python 3。

```bash
git clone https://github.com/lxl8800/xiangse-booksource.git
cd xiangse-booksource
npm ci
npm start
```

默认访问 `http://localhost:4397`。可通过 `HOST`、`PORT` 设置监听地址与端口。

只使用浏览器转换与 XBS 工具时，也可静态托管 `docs/`。域名检查、网站证据及服务端 AI 功能需要 Node.js API，单独部署 GitHub Pages 不会自动获得这些能力。

### Docker 部署

```bash
docker compose up -d --build
docker compose logs -f
```

默认映射端口 4397。已有服务使用该端口时，请先调整 `compose.yaml` 的宿主机端口。生产环境建议通过 HTTPS 反向代理访问，特别是在使用自定义 AI 接口时。

本仓库的发布准备不会自动更新现有生产服务。发布前应在独立端口验证首页、API、转换与 XBS 下载，并保留可回滚镜像。

## 开发与测试

```bash
# 纯 JavaScript 引擎测试，无需安装服务端依赖
node converter/test/run.js
node converter/test/units.js

# API、域名迁移、安全与自动修复回归
npm ci
npm test

# 浏览器交互测试（从项目根目录运行）
npm ci --prefix tests
node tests/test-ai-browser.js
node tests/test-domain-browser.js
node tests/test-sidebar-ui.js
node tests/test-xiangse-format.js

# 修改 converter/lib 后重新生成浏览器及 Android 内置 bundle
python3 app/tools/gen-converter-bundle.py
```

真实书源测试应记录输入、规则、提取样例及失败原因，分别区分连接错误、403 / 404、XPath 错误和网站结构变化。仓库中的样本及历史下载文件用于兼容性研究，不能视作全部可用的承诺。

可结合 [cloudmantou/xiangseSkill](https://github.com/cloudmantou/xiangseSkill) 的严格结构检查、编辑器兼容检查、fixture / live 模拟和 JSON / XBS 回读工具。四步网站检测通过也不能替代官方 App 的最终实测。

### 目录结构

| 路径 | 用途 |
| --- | --- |
| `converter/lib/` | 通用转换引擎；独立网站适配位于 `siteAdapters.js` |
| `converter/test/` | 引擎回归与单元测试 |
| `server/` | Node.js / Express API、网络安全、网站证据、修复与 AI 转发 |
| `server/tests/` | API 与通用能力回归 |
| `docs/` | 原生 HTML / CSS / JavaScript 工作台、规则文档和样本 |
| `tests/` | 浏览器交互测试及真实书源兼容样本 |
| `tools/xbs_codec.py` | JSON / XBS 编解码辅助工具 |
| `app/` | 保留的上游 Android 工具源码与 bundle 生成脚本 |
| `releases/` | 保留的上游 APK；本分支未重新构建或验证 |
| `Dockerfile`、`compose.yaml` | 服务端容器部署配置 |

上游 Android 工具的介绍和构建方法见 [原项目](https://github.com/ljun223/legado2xsgg)。本项目当前主要维护通用引擎和 Web 工作台，不把历史 APK 视作本分支的新发布。

## 隐私

- 普通规则转换在浏览器本地完成。
- 开启域名 / 网站检测会向所配置的服务端提交相应地址或书源，服务端再按允许范围访问目标网站。
- 主动使用 AI 时，所选书源、问题和检测证据会发送给配置的模型服务。
- Web 工作台的 AI Key 保存在当前浏览器本地配置中；调用时临时传递给服务端，不作为服务器持久化配置，也不应写入日志或 Git。
- 浏览器本地保存的 Key 仍受该浏览器与网站脚本的访问权限影响，共用设备请清除配置。
- 书源可能含 Cookie、Token 或私人接口地址，提交 issue、公开仓库或共享诊断前请自行脱敏。

## 参与贡献

欢迎提交可复现的规则问题和通用修复。请提供最小脱敏输入、期望结果、实际诊断及目标 App 版本。

优先将反复出现的问题沉淀为通用规则和回归测试。确实需要的网站适配应与核心逻辑隔离；不要为了某个样本通过而硬编码未经验证的 XPath。

请不要在 issue 中上传 API Key、登录 Cookie、私人书源或小说正文。

## 使用边界

本项目提供格式转换与兼容性研究工具，不提供或托管小说正文。用户自备书源及目标网站内容由相应权利人负责；请遵守目标网站的使用条件和适用规则。

本项目不是开源阅读或香色闺阁的官方项目，与目标 App 没有官方关联。软件按 MIT 许可证提供，不保证任意书源、站点或 App 版本均可使用。

## 致谢

- **[ljun223/legado2xsgg](https://github.com/ljun223/legado2xsgg)** —— 本项目直接上游，提供纯 JavaScript 转换引擎、网页与 Android 工具基础；特别感谢原作者 **ljun223**。
- [gedoor/legado](https://github.com/gedoor/legado) —— 开源阅读与 Legado 书源生态；感谢规则文档原作者 **Celeter**、整理者 **喵公子**。
- [urzeye/shuyuan-lab](https://github.com/urzeye/shuyuan-lab) —— 香色闺阁书源规则文档。
- [cloudmantou/xiangseSkill](https://github.com/cloudmantou/xiangseSkill) —— 香色闺阁格式契约、验证流程与工具参考。
- [brix/crypto-js](https://github.com/brix/crypto-js) —— 转换器使用的加密函数库。
- [xxtea/xxtea-go](https://github.com/xxtea/xxtea-go) —— 上游致谢中的 XBS / XXTEA 格式参考实现。
- [earendil-works/pi](https://github.com/earendil-works/pi) —— 可选 AI 功能使用的 `@earendil-works/pi-ai`。
- 感谢提供规则资料、脱敏样本、测试反馈和兼容性研究的贡献者。

## 许可证

[MIT License](LICENSE)。完整保留上游 `Copyright (c) 2026 ljun223` 版权声明。第三方库及参考工具适用各自许可证。
