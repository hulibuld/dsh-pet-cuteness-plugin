# dsh-pet-cuteness plugin

给 [`@linxin666/dsh-pet`](https://www.npmjs.com/package/@linxin666/dsh-pet)（DSH 右下角那只鲸鱼娘）配上一个"人"：

- **人格口吻**：按当前模型映射角色卡，注入系统提示词；会话级开关
- **中文思考**：要求模型直接用简体中文推理
- **头顶台词**：从模型自己的思考过程里摘人话，冒在挂件头顶（零额外请求、零 token）
- **每晚日记**：读 DSH 的会话日志，用 DeepSeek 写一篇按日期命名的 Markdown
- **设置页「大肥鱼的后台」**：日记设置、挂件状态、亲密度、小鱼干

它是附属插件，不能单独运行——没有 dsh-pet 就没有人出镜。

## 安装

```sh
npm i dsh-pet-cuteness-plugin@latest
```

然后在 DSH 的插件管理器里启用。它会自动用上已装的 `@linxin666/dsh-pet`。

> **如果你在插件管理器里装的时候看到「这个包没有声明组合包，无法作为插件安装」**：
> 多半是装到了早期的占位版本 `dsh-pet-cuteness-plugin@0.0.0-stage`（那一版还没有
> `dsh.bundle` 声明；当前唯一一个缺这个声明的版本）。请指定 `@latest` 或写死版本号 `@0.2.1` 以上再装；
> 从 `probe/` 目录 `link:` 进 profile 也可以（本地开发就是这么用的）。

> 不要用 `npm i github:hulibuld/dsh-pet-cuteness-plugin` 安装：npm 包根在 `probe/`
> 子目录，仓库根没有 `package.json`，从 git 装会找不到包。

当前版本：**0.2.2**（仓库内；npm 上最新正式版 0.2.1）。见 [CHANGELOG](probe/CHANGELOG.md)。

## 用法与常见问题

完整说明在 **[probe/README.md](probe/README.md)**：装完怎么验、日记怎么配、
记录文档和日记的区别、为什么不需要记忆插件、21:00 切日规则、出问题先看哪个诊断接口。

## 仓库结构

```
├── probe/                    ← npm 包本体（这里才是包根）
│   ├── index.js              宿主半：提示词段落、HTTP 桥、台词采集、日记调度
│   ├── src/                  纯逻辑模块（全部有单测）
│   ├── scripts/
│   │   ├── build-client.mjs  浏览器半的**真源**（client.js 由它生成）
│   │   ├── check-manifest.mjs
│   │   └── sync-data.mjs     把 data/ 的素材同步进 probe/data/
│   ├── tests/                433 条测试
│   └── README.md             用户向说明（= npm 页面内容）
├── data/                     人格卡素材真源（personas.zh.json 由 merge.py 合成）
├── tools/merge.py            把 data/lines/*.json 合并进人格卡
└── CHANGELOG.md              指向 probe/CHANGELOG.md
```

`probe/client.js` 是**构建产物，但纳入版本控制**——因为常见用法是把仓库目录直接
`link:` 进 DSH profile，那条路不会跑 npm 的 `prepare`，缺了它浏览器半就整个不加载。

改完 `probe/scripts/build-client.mjs` 记得 `npm run build` 再提交；
`npm run build:check` 会拦住忘了重建的提交。

## 开发

```sh
cd probe
npm run verify     # manifest 检查 + 素材同步检查 + 构建产物检查 + 全部测试
```

改浏览器半要改 `scripts/build-client.mjs`，**不要手改 `client.js`**（下次 build 会被覆盖）。

## 许可

MIT
