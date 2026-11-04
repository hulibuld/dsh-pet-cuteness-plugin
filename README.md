# dsh-pet-cuteness-plugin · 大肥鱼的后台

[![npm](https://img.shields.io/npm/v/dsh-pet-cuteness-plugin)](https://www.npmjs.com/package/dsh-pet-cuteness-plugin)
[![月下载](https://img.shields.io/npm/dm/dsh-pet-cuteness-plugin)](https://www.npmjs.com/package/dsh-pet-cuteness-plugin)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/hulibuld/dsh-pet-cuteness-plugin)
[![License](https://img.shields.io/npm/l/dsh-pet-cuteness-plugin)](LICENSE)

`dsh plugin --profile desktop add dsh-pet-cuteness-plugin` · [遇到问题开 issue](https://github.com/hulibuld/dsh-pet-cuteness-plugin/issues/new/choose)

给右下角那只鲸鱼娘配上「人」：让模型按角色口吻说话、用中文思考、在挂件头顶冒一两句心里话，每晚替你写一篇日记。

要配合 `@linxin666/dsh-pet`（右下角那只鲸鱼娘）用。没有它也能装、设置页也能开，但没人出镜、没有气泡可挂。

项目名是 dsh-pet-cuteness plugin，包名只能写成 `dsh-pet-cuteness-plugin`，市场里显示「大肥鱼的后台」，三个名字指同一个东西。

## 装

```
dsh plugin --profile desktop add dsh-pet-cuteness-plugin
```

装完重启 DSH。重启后输入框左边多三颗胶囊，挂件头顶能冒台词，设置里多一页「大肥鱼的后台」。

第一次用这么走：打开 设置 → 大肥鱼的后台，选一个日记本文件夹，在输入框左边点亮「语气」，再把同一句话问一遍。她换口吻回答，就是生效了。

## 装完多出什么

| 在哪 | 是什么 |
| --- | --- |
| 输入框左边 | 三颗胶囊：语气、中文思考、台词。各自管当前这个会话 |
| 挂件头顶 | 台词气泡，从模型的思考过程里摘人话，跟着挂件走 |
| 设置 → 大肥鱼的后台 | 日记设置、挂件状态、亲密度、小鱼干 |
| 日记本文件夹 | 每晚一篇 `<日期>.md`，标题和结尾都带日期 |

几个默认值先说清楚，免得以为坏了。语气默认关，人设段每个 model step 都要重算、占约 2 KB token，不让所有人默认多花钱。中文思考默认关，同样为省 token。台词默认开，它零成本，只读模型自己的思考，不额外请求。亲密度和小鱼干默认收起，不点开就一个请求都不发。

## 日记

日记直接读 DSH 自己的会话日志，用 Node 自带的 zstd，不引第三方依赖，也不需要装任何记忆插件。

会话归档了照样能写。归档只是往工作区配置里记一份会话 ID 名单，用来在侧边栏藏起来，会话文件本身还在磁盘上，日记扫的是文件，不查那份名单。

每天 21:00 切日。21:00 之前算当天，之后算第二天。所以 22:30 的对话写进明天的日记，而 21:00 定时触发的那一篇，写的是刚刚结束的那一天。

日记本文件夹里还有个 `AI娘日记记录.md`，那是账本，存你的设置、今天聊了多少段、最近写过哪几篇。真正的日记是按日期单独存的 Markdown。账本给程序看，手改它她就认不出来了。

日记由你选的那条 DeepSeek 模型写。默认「自动」= 用你登录的账号那条 API。换成非 DeepSeek 的模型会直接被打回，不会悄悄换别的东西去跑。

## 排障

先看 `http://127.0.0.1:<端口>/api/dsh-pet-cuteness-plugin/debug`：`stage` 是不是 `ready`，`attached` 里有没有当前会话，`scheduler` 有没有在跳。

再硬刷新一次（⌘⇧R）。插件更新后浏览器里跑的可能是旧 bundle。

白屏多半是组件渲染时抛错，把 overlay 那条 entry 搞挂了。模型名读不到，是读错了创建时的默认值，应该读 `modelSelection.next.model`。人设段落没生效，可能是这版宿主取不到 `DEPLOYMENT_PERSONA_PREFIX` 的顺序，这种情况下插件选择不注册，不猜数字。

## 边界

不改 dsh-pet，挂件是别人的包，只出现在它允许的位置。不代装 dsh-pet，只在 peerDependencies 里声明加运行期探测，没装就提示。不碰系统提示词里的时间、随机数、会话 id，那会打穿前缀缓存。不往 `document.body` 追加节点，不用 iframe。亲密度和小鱼干只在你说要改的时候写，写前备份，写完回读核对，对不上就还原。

## 开发

```
cd probe
npm run build
npm run verify
```

改逻辑改 `src/` 下的 `.mjs`，不要改 `client.js`，那是构建产物。改素材改上游真源再同步。提交前 `npm run verify` 必须绿。

## 许可

MIT。
