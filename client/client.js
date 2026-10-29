/**
 * dsh-omnibridge client bundle：整合进 DSH WebUI 的「消息桥」配置中枢。
 *
 * 架构对齐 dsh-vision-router / dshmarket 的标准插件 UI 模式：
 *  - 无打包器，CJS 工厂经 window.__ModuleLoader__.load 注册，React 由平台 seed 提供；
 *  - 注册两个 slot：
 *      settings.section     设置页「消息桥」主面板（本插件的功能主体）
 *      settings.plugin.item 设置→插件 列表卡片（摘要 + 快捷开关）
 *  - 数据面：
 *      GET/POST /dsh-omnibridge/status | /dsh-omnibridge/settings
 *      （状态/总开关；POST {patch} 经后端 scope.update 写 settings.yaml 并热重载）
 *      POST <webchatPath>/send（wait=true）、GET <webchatPath>/poll（聊天/指令）
 *
 * 安全设计（fiber FAILED 会让整个 WebUI 卡在启动失败页，层层设防）：
 *  - apply 整体 try/catch；副作用一律 ctx.effect(fn, tag)；依赖缺失提前 return；
 *  - settingsScope 缺失时配置 tab 降级为只读提示，其余 tab 不受影响。
 *
 * @module dsh-omnibridge/client
 */

;(function register() {
  var loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : null
  if (!loader || typeof loader.load !== 'function') return
  loader.load({
    id: 'dsh-omnibridge',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      var React = require('react')
      var h = React.createElement

      var NS = 'dsh-omnibridge'
      var STATUS_API = '/dsh-omnibridge/status'
      var SETTINGS_API = '/dsh-omnibridge/settings'
      var DEFAULT_WEBCHAT_PATH = '/dsh-omnibridge/webchat/webchat'
      var WEBHOOK_FORMATS = ['auto', 'feishu', 'wecom', 'wecom_ai', 'dingtalk', 'line', 'mp', 'custom']

      /** Webhook 平台预设：渠道配置里的平台卡片（对齐 AstrBot 每平台一节的配置观感）。 */
      var WEBHOOK_PRESETS = [
        { format: 'feishu', idBase: 'feishu', name: '飞书（Lark）', desc: '事件订阅回调入站 + 自定义机器人 webhook 出站', fields: ['path', 'outboundUrl'] },
        { format: 'wecom', idBase: 'wecom', name: '企业微信', desc: '群机器人 webhook 出站（回调 MsgType=text）', fields: ['outboundUrl'] },
        { format: 'wecom_ai', idBase: 'wecom-ai', name: '企微智能机器人', desc: '智能机器人回调入站', fields: ['path'] },
        { format: 'dingtalk', idBase: 'dingtalk', name: '钉钉', desc: '自定义机器人（明文 text）', fields: ['outboundUrl'] },
        { format: 'line', idBase: 'line', name: 'LINE', desc: 'Messaging API：replyToken 优先，Push 兜底', fields: ['path', 'channelAccessToken'] },
        { format: 'mp', idBase: 'mp', name: '微信公众号', desc: '明文模式回调 + 客服消息出站', fields: ['path', 'mpAccessToken'] },
        { format: 'custom', idBase: 'qqofficial', name: 'QQ 官方机器人（回调）', desc: '现以 format=custom 解析开放平台回调；官方适配器（验签+回发）在路线图', fields: ['path'], qq: true },
        { format: 'custom', idBase: 'custom', name: '自定义 JSON', desc: '{text, sender_id, session_key} —— 任意 HTTP 客户端接入', fields: ['path', 'outboundUrl'] },
      ]
      function belongsPreset(wh, p) {
        var f = wh.format || 'auto'
        if (p.qq) return f === 'custom' && String(wh.id || '').indexOf('qqofficial') === 0
        if (p.idBase === 'custom') return (f === 'custom' || f === 'auto') && String(wh.id || '').indexOf('qqofficial') !== 0
        return f === p.format
      }

      // ————————————————————————— 样式（中性色，深浅主题可读） —————————————————————————

      var S = {
        panel: { border: '1px solid rgba(127,127,127,.28)', borderRadius: '10px', padding: '12px 14px', margin: '10px 0', background: 'rgba(127,127,127,.05)' },
        row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
        between: { display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '5px 0', borderBottom: '1px solid rgba(127,127,127,.13)' },
        grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px 14px', margin: '8px 0' },
        fieldLabel: { fontSize: '11.5px', opacity: .6, marginBottom: '3px' },
        mono: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', fontSize: '11.5px', opacity: .85 },
        dim: { opacity: .62, fontSize: '12px' },
        btn: { cursor: 'pointer', borderRadius: '6px', padding: '3px 12px', background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.42)', fontSize: '12px' },
        btnPrimary: { cursor: 'pointer', borderRadius: '6px', padding: '4px 14px', color: '#fff', background: '#388bfd', border: 'none', fontSize: '12.5px', fontWeight: 600 },
        btnDanger: { cursor: 'pointer', borderRadius: '6px', padding: '2px 10px', color: '#f85149', background: 'transparent', border: '1px solid rgba(248,81,73,.45)', fontSize: '11.5px' },
        input: { borderRadius: '6px', border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', padding: '4px 8px', fontSize: '12.5px', width: '100%', boxSizing: 'border-box' },
        pillOn: { background: 'rgba(63,185,80,.18)', color: '#3fb950', borderRadius: '999px', padding: '1px 10px', fontSize: '11.5px', fontWeight: 600 },
        pillOff: { background: 'rgba(127,127,127,.2)', opacity: .8, borderRadius: '999px', padding: '1px 10px', fontSize: '11.5px' },
        switch: function (on) { return { cursor: 'pointer', borderRadius: '999px', padding: '2px 12px', fontSize: '11.5px', fontWeight: 600, border: '1px solid', color: on ? '#3fb950' : 'inherit', borderColor: on ? 'rgba(63,185,80,.55)' : 'rgba(127,127,127,.4)', background: on ? 'rgba(63,185,80,.12)' : 'transparent' } },
        tabBtn: function (active) { return { cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit', padding: '6px 4px', marginRight: '16px', fontSize: '13px', fontWeight: active ? 700 : 400, opacity: active ? 1 : .55, borderBottom: active ? '2px solid currentColor' : '2px solid transparent' } },
        bubbleIn: { alignSelf: 'flex-start', background: 'rgba(127,127,127,.17)', borderRadius: '10px 10px 10px 2px' },
        bubbleOut: { alignSelf: 'flex-end', background: 'rgba(56,139,253,.22)', borderRadius: '10px 10px 2px 10px' },
        bubbleSys: { alignSelf: 'center', fontStyle: 'italic', opacity: .6 },
        bubbleBase: { maxWidth: '76%', padding: '6px 10px', fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 },
        err: { color: '#f85149', fontSize: '12px' },
        ok: { color: '#3fb950', fontSize: '12px' },
        tableHead: { textAlign: 'left', fontSize: '11px', opacity: .55, padding: '2px 8px' },
        tableCell: { fontSize: '11.5px', padding: '3px 8px', borderTop: '1px solid rgba(127,127,127,.13)' },
        chip: { cursor: 'pointer', textAlign: 'left', borderRadius: '8px', border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit', padding: '6px 10px', fontSize: '12px' },
        logRow: { borderBottom: '1px solid rgba(127,127,127,.13)', padding: '6px 2px', fontSize: '12px' },
        title: { fontWeight: 700, fontSize: '13px' },
      }

      function fmtTime(ts) {
        try { return new Date(ts).toLocaleTimeString() } catch (e) { return '' }
      }

      async function fetchJson(url, options) {
        var resp = await fetch(url, Object.assign({}, options, {
          headers: Object.assign({ 'Content-Type': 'application/json' }, (options && options.headers) || {}),
        }))
        if (!resp.ok) throw new Error(((options && options.method) || 'GET') + ' ' + url + ' -> ' + resp.status)
        return resp.json()
      }

      async function postEnabled(next) {
        return fetchJson(SETTINGS_API, { method: 'POST', body: JSON.stringify({ enabled: next }) })
      }

      // ————————————————————————— 共享小部件 —————————————————————————

      /** 启用开关（pill 式）。 */
      function Switch(props) {
        var on = !!props.on
        return h('button', {
          style: S.switch(on),
          disabled: !!props.disabled,
          title: props.title || '',
          onClick: props.onToggle,
        }, on ? '已启用' : '已停用')
      }

      function Pill(props) { return h('span', { style: props.on ? S.pillOn : S.pillOff }, props.text) }

      /** 下拉不用系统白菜单，跟当前窗口的底色走。 */
      function EnumSelect(props) {
        var options = props.spec.options || []
        var value = props.value
        var onChange = props.onChange
        var openState = React.useState(false)
        var open = openState[0], setOpen = openState[1]
        var placeState = React.useState(null)
        var place = placeState[0], setPlace = placeState[1]
        var btnRef = React.useRef(null)
        var picked = null
        for (var i = 0; i < options.length; i++) if (options[i].value === value) picked = options[i]
        if (!picked && options.length) picked = options[0]
        function opaqueBackground(node) {
          var el = node
          while (el) {
            var color = window.getComputedStyle(el).backgroundColor
            var match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(color || '')
            var alpha = !match ? 1 : (match[4] == null ? 1 : Number(match[4]))
            if (match && alpha >= 0.9) return color
            el = el.parentElement
          }
          return ''
        }
        function toggle() {
          if (open) { setOpen(false); return }
          var node = btnRef.current
          if (!node) return
          var rect = node.getBoundingClientRect()
          var text = window.getComputedStyle(node).color
          var rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text || '')
          var light = !rgb || ((Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3) > 140
          setPlace({
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            color: text,
            background: opaqueBackground(node.parentElement) || (light ? '#2c2c2e' : '#f4f4f5'),
          })
          setOpen(true)
        }
        React.useEffect(function () {
          if (!open) return undefined
          function onDoc(event) {
            var root = btnRef.current && btnRef.current.parentElement
            if (root && root.contains(event.target)) return
            setOpen(false)
          }
          document.addEventListener('mousedown', onDoc)
          return function () { document.removeEventListener('mousedown', onDoc) }
        }, [open])
        return h('div', { style: { position: 'relative' } },
          h('button', {
            ref: btnRef,
            type: 'button',
            style: Object.assign({}, S.input, { textAlign: 'left', cursor: 'pointer' }),
            onClick: toggle,
          }, (picked ? picked.label : '') + '  ▾'),
          open && place ? h('div', {
            style: {
              position: 'fixed',
              zIndex: 80,
              top: place.top,
              left: place.left,
              width: place.width,
              background: place.background,
              color: place.color,
              border: '1px solid rgba(127,127,127,.4)',
              borderRadius: '8px',
              boxShadow: '0 10px 28px rgba(0,0,0,.45)',
              padding: '4px',
            },
          }, options.map(function (option) {
            var on = picked && option.value === picked.value
            return h('button', {
              key: option.value,
              type: 'button',
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                border: 'none',
                borderRadius: '6px',
                padding: '7px 8px',
                fontSize: '12.5px',
                color: 'inherit',
                background: on ? 'rgba(127,127,127,.28)' : 'transparent',
              },
              onMouseEnter: function (event) { if (!on) event.currentTarget.style.background = 'rgba(127,127,127,.16)' },
              onMouseLeave: function (event) { if (!on) event.currentTarget.style.background = 'transparent' },
              onClick: function () { onChange(option.value); setOpen(false) },
            }, option.label)
          })) : null)
      }

      /** 通用字段输入（bool/number/text/secret/lines）。 */
      function FieldInput(props) {
        var spec = props.spec
        var value = props.value
        var onChange = props.onChange
        if (spec.type === 'bool') {
          return h('button', { style: S.switch(!!value), onClick: function () { onChange(!value) } }, value ? '开' : '关')
        }
        if (spec.type === 'enum') return h(EnumSelect, { spec: spec, value: value, onChange: onChange })
        var type = spec.type === 'number' ? 'number' : (spec.type === 'secret' ? 'password' : 'text')
        if (spec.type === 'lines') {
          return h('textarea', {
            style: Object.assign({}, S.input, { minHeight: '52px', resize: 'vertical', fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: '11.5px' }),
            value: Array.isArray(value) ? value.join('\n') : String(value == null ? '' : value),
            placeholder: spec.ph || '一行一条',
            onChange: function (e) {
              onChange(e.target.value.split('\n').map(function (s) { return s.trim() }).filter(Boolean))
            },
          })
        }
        var common = {
          style: Object.assign({}, S.input, spec.type === 'secret' ? { fontFamily: 'ui-monospace,Menlo,Consolas,monospace' } : null),
          value: value == null ? '' : String(value),
          placeholder: spec.ph || '',
          onChange: function (e) {
            onChange(spec.type === 'number' ? (e.target.value === '' ? 0 : Number(e.target.value)) : e.target.value)
          },
        }
        return spec.type === 'textarea'
          ? h('textarea', Object.assign({}, common, { style: Object.assign({}, S.input, { minHeight: '46px', resize: 'vertical' }) }))
          : h('input', Object.assign({ type: type }, common))
      }

      /** 单字段（label + hint + input）。 */
      function FieldRow(props) {
        var spec = props.spec
        return h('div', null,
          h('div', { style: S.fieldLabel }, spec.label || spec.f),
          h(FieldInput, { spec: spec, value: props.value, onChange: props.onChange }),
          spec.hint ? h('div', { style: { fontSize: '10.5px', opacity: .5, marginTop: '2px' } }, spec.hint) : null)
      }

      // ————————————————————————— 状态数据 hooks —————————————————————————

      function useStatus() {
        var st = React.useState(null)
        var data = st[0], setData = st[1]
        var se = React.useState('')
        var err = se[0], setErr = se[1]
        var refresh = React.useCallback(function () {
          return fetchJson(STATUS_API).then(function (j) { setData(j); setErr('') })
            .catch(function (e) { setErr(String((e && e.message) || e)) })
        }, [])
        React.useEffect(function () { refresh() }, [refresh])
        React.useEffect(function () {
          var t = setInterval(refresh, 5000)
          return function () { clearInterval(t) }
        }, [refresh])
        return { data: data, err: err, refresh: refresh }
      }

      /** webchat 路径（跟随配置，空值回退默认）。 */
      function useWebchatBase() {
        var sb = React.useState(DEFAULT_WEBCHAT_PATH)
        var base = sb[0], setBase = sb[1]
        React.useEffect(function () {
          var alive = true
          fetchJson(SETTINGS_API).then(function (cfg) {
            if (!alive) return
            var p = (cfg && cfg.webchat && cfg.webchat.path) || DEFAULT_WEBCHAT_PATH
            if (p.endsWith('/')) p = p.slice(0, -1)
            setBase(p)
          }).catch(function () {})
          return function () { alive = false }
        }, [])
        return base
      }

      function EnabledToggleRow(props) {
        var st = React.useState(false)
        var busy = st[0], setBusy = st[1]
        function toggle() {
          if (busy) return
          setBusy(true)
          postEnabled(!props.enabled).then(props.onDone).catch(props.onError || function () {})
            .finally(function () { setBusy(false) })
        }
        return h('div', { style: S.row },
          h('button', { style: Object.assign({}, S.btn, busy ? { opacity: .5 } : null), disabled: busy, onClick: toggle },
            busy ? '切换中…' : (props.enabled ? '✅ 已启用——点击关闭' : '⛔ 已关闭——点击开启')),
          h(Pill, { on: !!props.enabled, text: props.enabled ? 'ON' : 'OFF' }))
      }

      // ————————————————————————— Tab 1：运行状态 —————————————————————————

      function StatusTab() {
        var s = useStatus()
        var data = s.data, err = s.err, refresh = s.refresh

        function toggle() {
          postEnabled(!(data && data.enabled)).then(refresh).catch(function () {})
        }

        var summary = data && data.summary
        var rl = summary && summary.rateLimit
        var channels = (data && data.channels) || []
        var details = (summary && summary.routeDetails) || []

        return h('div', null,
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: '8px' }) },
            h('span', { style: S.title }, '运行状态'),
            h('button', { style: S.btn, onClick: refresh }, '↻ 刷新')),
          err ? h('div', { style: S.err, style: Object.assign({}, S.err, { marginBottom: '6px' }) }, '⚠ ' + err) : null,
          !data ? h('div', { style: S.dim }, '加载中…') : h('div', null,
            h('div', { style: S.panel }, h(EnabledToggleRow, { enabled: !!data.enabled, onDone: refresh })),
            h('div', { style: S.panel },
              h('div', { style: Object.assign({}, S.title, { marginBottom: '6px' }) }, '渠道（' + channels.length + '）'),
              channels.length === 0 ? h('div', { style: S.dim }, '无渠道注册') : channels.map(function (c) {
                return h('div', { key: c.id, style: S.between },
                  h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, c.name || c.id),
                  c.name && c.name !== c.id ? h('code', { style: S.mono }, c.id) : null,
                  h(Pill, { on: !!c.enabled, text: c.enabled ? '运行中' : '未启用' }))
              })),
            h('div', { style: S.panel },
              h('div', { style: Object.assign({}, S.title, { marginBottom: '6px' }) }, '安全与限流'),
              infoLine('allowFrom 白名单', formatAllow(data)),
              infoLine('速率限制', rl ? (rl.maxPerMinute > 0 ? ('每 ' + Math.round((rl.windowMs || 60000) / 1000) + 's ≤ ' + rl.maxPerMinute + ' 条' + (rl.silent ? '（静默）' : '') + '，跟踪 ' + rl.trackedSenders + ' 人') : '不限速') : '-'),
              infoLine('闲置会话 TTL', summary && summary.sessionTtlMinutes > 0 ? summary.sessionTtlMinutes + ' 分钟自动清理' : '关闭（可 /gc 手动）'),
              infoLine('路由数', String(summary ? summary.routes : 0))),
            h('div', { style: S.panel },
              h('div', { style: Object.assign({}, S.title, { marginBottom: '6px' }) }, '会话路由明细'),
              details.length === 0 ? h('div', { style: S.dim }, '暂无路由（发消息后懒创建）') : routeTable(details))))
      }

      function infoLine(label, value) {
        return h('div', { style: Object.assign({}, S.row, { padding: '3px 0', fontSize: '12px' }) },
          h('span', { style: { opacity: .6, minWidth: '110px' } }, label),
          h('span', { style: S.mono }, value == null ? '-' : String(value)))
      }

      function formatAllow(data) {
        var list = (data && data.allowFrom) || []
        if (!list.length) return '（空 = 拒绝所有入站！）'
        if (list.indexOf('*') >= 0) return '*（全部放行）'
        return list.join(', ')
      }

      function routeTable(details) {
        var shown = details.slice(0, 20)
        return h('div', null,
          h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
            h('thead', null, h('tr', null, ['sessionKey', 'sessionId', 'channel', '空闲'].map(function (th) {
              return h('th', { key: th, style: S.tableHead }, th)
            }))),
            h('tbody', null, shown.map(function (r, i) {
              return h('tr', { key: r.sessionKey || i },
                h('td', { style: S.tableCell }, r.sessionKey),
                h('td', { style: S.tableCell }, r.sessionId || '-'),
                h('td', { style: S.tableCell }, r.channel || '-'),
                h('td', { style: S.tableCell }, r.idleSeconds == null ? '-' : r.idleSeconds + 's'))
            }))),
          details.length > 20 ? h('div', { style: S.dim }, '…另有 ' + (details.length - 20) + ' 条未列出') : null)
      }

      // ————————————————————————— Tab 2：渠道配置（settings seam 写回） —————————————————————————

      // 声明式分组：仅描述要编辑的顶层字段及其内部字段
      var CONFIG_GROUPS = [
        {
          key: 'general', title: '通用', desc: '新会话的默认 Agent 参数', topLevel: true, fields: [
            { f: 'agentPreset', label: 'Agent 预设', type: 'enum', options: [
              { value: 'standard', label: 'standard · 搜索、改文件、跑命令' },
              { value: 'minimal', label: 'minimal · 只聊天' },
              { value: 'ptc', label: 'ptc · 搜索和命令，外加更复杂的调用' },
              { value: 'cordis', label: 'cordis · 改 DeepSeek 插件用' },
            ] },
            { f: 'agentProvider', label: 'Provider', ph: '留空=默认' },
            { f: 'agentModel', label: 'Model', ph: '如 nvidia/deepseek-ai/deepseek-v4-flash-0731' },
            { f: 'cwd', label: '工作目录', ph: '/root' },
            { f: 'maxMessageChars', label: '单条回复上限（字符）', type: 'number' },
            { f: 'sessionTtlMinutes', label: '闲置会话 TTL（分钟）', type: 'number', hint: '0 = 不自动清理' },
          ],
        },
        {
          key: 'security', title: '安全与唤醒', desc: '对齐 AstrBot waking / 权限语义', topLevel: true, fields: [
            { f: 'allowFrom', label: 'allowFrom 白名单', type: 'lines', hint: '空 = 拒绝所有入站；支持 *、平台:*、平台:id' },
            { f: 'admins', label: 'admins 管理员', type: 'lines', hint: '空 = 白名单全员即管理员；/model /gc /sessions /switch 受限' },
            { f: 'wakePrefixes', label: '唤醒前缀', type: 'lines', hint: '空 = 不启用；配置后普通消息需带前缀' },
            { f: 'rateLimit', type: 'object', label: '速率限制', fields: [
              { f: 'maxPerMinute', label: '每窗口最大条数（0=不限）', type: 'number' },
              { f: 'windowMs', label: '窗口（ms）', type: 'number' },
              { f: 'silent', label: '命中限速静默', type: 'bool' },
            ] },
            { f: 'mediaAllowPrivateHosts', label: '放行私网媒体地址', type: 'bool', hint: '自托管 NapCat 等给局域网链接时开启' },
          ],
        },
        {
          key: 'onebot', title: 'QQ · OneBot v11', desc: 'NapCat / go-cqhttp / Lagrange 正向 WS。表情、语音和群唤醒只作用在这一路', enable: true, fields: [
            { f: 'url', label: 'WS 地址', type: 'secret', ph: 'ws://127.0.0.1:3001?access_token=…', hint: '一般不用改。登录、目录和扫码在「NapCat」页。' },
            { f: 'reconnectDelayMs', label: '重连基间隔（ms）', type: 'number' },
            { f: 'groupAtOnly', label: '群聊需 @ 或喊醒', type: 'bool' },
            { f: 'groupWakeWords', label: '群聊唤醒词', type: 'lines', hint: '喊到这些词也会叫醒她，私聊不用喊' },
            { f: 'ownerIds', label: '主人 QQ', type: 'lines', hint: '这些号在她眼里是主人，对方看不到这行标记' },
            { f: 'voiceReply', label: '私聊默认回语音', type: 'bool' },
          ],
        },
        {
          key: 'telegram', title: 'Telegram', desc: 'Bot API long polling（@BotFather 申请 token）', enable: true, fields: [
            { f: 'token', label: 'Bot Token', type: 'secret', ph: '123456:ABC…' },
            { f: 'apiBase', label: 'API 基址', ph: '留空 = 官方' },
            { f: 'pollIntervalMs', label: '轮询间隔（ms）', type: 'number' },
            { f: 'groupAtOnly', label: '群聊仅 @机器人', type: 'bool' },
          ],
        },
        {
          key: 'satori', title: 'Satori（Discord/KOOK/Slack…）', desc: '经 Satori 网关接入多平台', enable: true, fields: [
            { f: 'baseUrl', label: '网关地址', ph: 'http://127.0.0.1:5140' },
            { f: 'token', label: 'Token', type: 'secret', ph: '' },
            { f: 'reconnectDelayMs', label: '重连基间隔（ms）', type: 'number' },
            { f: 'groupAtOnly', label: '群聊仅 @机器人', type: 'bool' },
          ],
        },
        {
          key: 'webchat', title: 'WebChat', desc: 'HTTP 聊天端点（本面板聊天/指令的数据面）', enable: true, fields: [
            { f: 'path', label: '路径', ph: '留空 = /dsh-omnibridge/webchat/webchat' },
            { f: 'retentionMinutes', label: '出站保留（分钟）', type: 'number' },
          ],
        },
        {
          key: 'weixin_oc', title: '个人微信（iLink）', desc: '官方接口，无 token 时启动扫码（日志与 /weixin_oc/qrcode.png）', enable: true, fields: [
            { f: 'baseUrl', label: 'API 基址', ph: '留空 = 官方' },
            { f: 'token', label: 'bot_token', type: 'secret', ph: '留空 = 扫码登录' },
            { f: 'botType', label: 'bot_type', ph: '3' },
            { f: 'statePath', label: '状态文件路径', ph: '留空 = 插件目录默认' },
          ],
        },
        { key: 'webhooks', title: 'Webhook 实例', desc: '飞书/企微/钉钉/LINE/公众号/QQ官方回调等，一实例一平台', webhookList: true },
      ]

      function clone(v) { return JSON.parse(JSON.stringify(v == null ? null : v)) }

      /** 顶层字段规格表（含嵌套 object/webhookList）。 */
      function fieldSpecs() {
        var map = {}
        CONFIG_GROUPS.forEach(function (g) {
          if (g.webhookList) { map[g.key] = { type: 'webhookList' }; return }
          g.fields.forEach(function (f) {
            if (f.type === 'object') map[f.f] = { type: 'object', fields: f.fields }
            else map[f.f] = { type: f.type || 'text' }
          })
        })
        return map
      }

      /** 规范化草稿：number 字段强制 Number，避免字符串写入。 */
      function normalizeDraft(draft) {
        var specs = fieldSpecs()
        var out = clone(draft) || {}
        Object.keys(specs).forEach(function (k) {
          if (!(k in out)) return
          var spec = specs[k]
          if (spec.type === 'number') out[k] = Number(out[k]) || 0
          else if (spec.type === 'object') {
            var sub = out[k] || (out[k] = {})
            spec.fields.forEach(function (f) {
              if (f.type === 'number') sub[f.f] = Number(sub[f.f]) || 0
              if (f.type === 'bool') sub[f.f] = !!sub[f.f]
            })
          } else if (spec.type === 'bool') out[k] = !!out[k]
        })
        return out
      }

      function ConfigTab() {
        var sr = React.useState(null)
        var remote = sr[0], setRemote = sr[1]
        var sd = React.useState(null)
        var draft = sd[0], setDraft = sd[1]
        var sm = React.useState(null)
        var msg = sm[0], setMsg = sm[1]
        var ss = React.useState(false)
        var saving = ss[0], setSaving = ss[1]
        var sl = React.useState('')
        var loadErr = sl[0], setLoadErr = sl[1]

        var load = React.useCallback(function () {
          return fetchJson(SETTINGS_API).then(function (cfg) {
            setRemote(cfg); setDraft(normalizeDraft(cfg)); setLoadErr(''); setMsg(null)
          }).catch(function (e) { setLoadErr(String((e && e.message) || e)) })
        }, [])
        React.useEffect(function () { load() }, [load])

        if (loadErr) return h('div', null,
          h('div', { style: S.err }, '⚠ ' + loadErr),
          h('button', { style: S.btn, onClick: load }, '重试'))

        function setField(key, value) {
          setDraft(function (prev) {
            var next = clone(prev) || {}
            next[key] = value
            return next
          })
          setMsg(null)
        }
        function setSub(group, f, value) {
          setDraft(function (prev) {
            var next = clone(prev) || {}
            var obj = Object.assign({}, next[group] || {})
            obj[f] = value
            next[group] = obj
            return next
          })
          setMsg(null)
        }

        var changedFields = []
        if (remote && draft) {
          normalizeDraft(remote && remote)
          Object.keys(fieldSpecs()).forEach(function (k) {
            if (k === 'enabled') return
            if (JSON.stringify(draft[k]) !== JSON.stringify(remote[k])) changedFields.push(k)
          })
        }

        function save() {
          if (saving || !changedFields.length) return
          setSaving(true); setMsg(null)
          var payload = normalizeDraft(draft)
          var patch = {}
          changedFields.forEach(function (k) { patch[k] = payload[k] })
          // 经插件自身同源端点写 settings.yaml user 层（后端 scope.update，schema 校验）
          fetchJson(SETTINGS_API, { method: 'POST', body: JSON.stringify({ patch: patch }) })
            .then(function (cfg) {
              setRemote(cfg); setDraft(normalizeDraft(cfg))
              setMsg({ kind: 'ok', text: '已写入 settings.yaml，桥接自动热重载（1-2 秒生效）' })
            })
            .catch(function (e) {
              setMsg({ kind: 'err', text: '保存失败：' + String((e && e.message) || e) })
            })
            .finally(function () { setSaving(false) })
        }

        function discard() { setDraft(clone(remote)); setMsg(null) }

        function renderGroup(g) {
          if (g.webhookList) {
            var whList = (draft && draft.webhooks) || []
            function whSet(idx, f, v) {
              var next = clone(whList)
              next[idx] = Object.assign({}, next[idx])
              next[idx][f] = v
              setField('webhooks', next)
            }
            function addInstance(preset) {
              var next = clone(whList) || []
              var uniq = preset.idBase
              var n = 1
              while (next.some(function (w) { return w.id === uniq })) uniq = preset.idBase + '-' + (++n)
              next.push({ id: uniq, enabled: false, format: preset.format, path: '/dsh-omnibridge/webhook/' + uniq, outboundUrl: '', channelAccessToken: '', mpAccessToken: '' })
              setField('webhooks', next)
            }
            var WH_FIELD_LABELS = { path: '回调路径', outboundUrl: '机器人 Webhook（出站）', channelAccessToken: 'channelAccessToken', mpAccessToken: 'mpAccessToken' }
            var presetCards = WEBHOOK_PRESETS.map(function (p) {
              var insts = []
              whList.forEach(function (wh, i) { if (belongsPreset(wh, p)) insts.push({ wh: wh, i: i }) })
              var enabledCount = insts.filter(function (x) { return !!x.wh.enabled }).length
              var head = h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
                h('span', { style: S.title }, p.name),
                insts.length === 0
                  ? h('button', { style: S.btn, onClick: function () { addInstance(p) } }, '＋ 接入')
                  : h(Pill, { on: enabledCount > 0, text: enabledCount + '/' + insts.length + ' 启用' }))
              var cardKids = [head, h('div', { style: S.dim }, p.desc)]
              insts.forEach(function (x) {
                var wh = x.wh
                var idx = x.i
                var setF = function (f, v) { whSet(idx, f, v) }
                var fieldRows = (p.fields || []).map(function (fk) {
                  var spec = { f: fk, label: WH_FIELD_LABELS[fk] || fk }
                  if (fk === 'path') spec.ph = '/dsh-omnibridge/webhook/…'
                  if (fk === 'outboundUrl' || fk === 'channelAccessToken' || fk === 'mpAccessToken') spec.type = 'secret'
                  return h(FieldRow, { key: fk, spec: spec, value: wh[fk], onChange: function (v) { setF(fk, v) } })
                })
                var formatSelect = h('select', {
                  style: Object.assign({}, S.input, { maxWidth: '140px', colorScheme: 'dark' }),
                  value: wh.format || 'auto',
                  onChange: function (e) { setF('format', e.target.value) }
                }, WEBHOOK_FORMATS.map(function (f) {
                  return h('option', { key: f, value: f, style: { background: '#24292f', color: '#e6e6e6' } }, f)
                }))
                var header = h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
                  h('input', {
                    style: Object.assign({}, S.input, { maxWidth: '150px', fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: '11.5px' }),
                    value: wh.id || '', title: '实例 id（回调路由前缀）',
                    onChange: function (e) { setF('id', e.target.value) }
                  }),
                  h('div', { style: S.row },
                    Switch({ on: !!wh.enabled, onToggle: function () { setF('enabled', !wh.enabled) } }),
                    h('button', { style: S.btnDanger, onClick: function () { setField('webhooks', whList.filter(function (_, j) { return j !== idx })) } }, '删除')))
                cardKids.push(h('div', { key: wh.id || idx, style: Object.assign({}, S.panel, { margin: '8px 0 0' }) },
                  header,
                  h('div', { style: S.grid }, fieldRows),
                  h('div', { style: Object.assign({}, S.row, { marginTop: '4px' }) },
                    h('span', { style: S.fieldLabel }, 'format'),
                    formatSelect)))
              })
              return h('div', { key: p.idBase, style: Object.assign({}, S.panel, { margin: '0' }) }, cardKids)
            })
            return h('div', { style: S.panel, key: g.key },
              h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
                h('span', { style: S.title }, 'Webhook 平台接入'),
                h('span', { style: S.dim }, '一实例一平台 · 回调填到对应平台后台')),
              h('div', { style: S.dim, marginBottom: '4px' }, g.desc),
              h('div', { style: S.grid }, presetCards))
          }
          var val = draft ? draft[g.key] : undefined
          // 顶层组（general/security）字段直接读写 draft 顶层键；渠道组字段嵌套在渠道对象下
          var isTop = !!g.topLevel
          var getVal = function (f) {
            if (isTop) return draft ? draft[f] : undefined
            return val == null ? undefined : val[f]
          }
          var setVal = function (f, v) {
            if (isTop) setField(f, v)
            else setSub(g.key, f, v)
          }
          var enableCtl = g.enable && draft
            ? Switch({ on: !!(val && val.enabled), onToggle: function () { setSub(g.key, 'enabled', !(val && val.enabled)) } })
            : null
          return h('div', { style: S.panel, key: g.key },
            h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
              h('span', { style: S.title }, g.title),
              enableCtl),
            h('div', { style: S.dim, marginBottom: '4px' }, g.desc),
            h('div', { style: S.grid }, g.fields.map(function (f) {
              if (f.type === 'object') {
                var obj = getVal(f.f) || {}
                return h('div', { key: f.f, style: Object.assign({}, S.panel, { gridColumn: '1 / -1', margin: '4px 0' }) },
                  h('div', { style: Object.assign({}, S.title, { marginBottom: '4px', fontSize: '12px' }) }, f.label || f.f),
                  h('div', { style: S.grid }, f.fields.map(function (sub) {
                    return h(FieldRow, {
                      key: sub.f, spec: sub, value: (obj || {})[sub.f],
                      onChange: function (v) {
                        var nextSub = Object.assign({}, obj)
                        nextSub[sub.f] = v
                        setVal(f.f, nextSub)
                      },
                    })
                  })))
              }
              return h(FieldRow, {
                key: f.f, spec: f, value: getVal(f.f),
                onChange: function (v) { setVal(f.f, v) },
              })
            })))
        }

        return h('div', null,
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: '8px' }) },
            h('span', { style: S.title }, '渠道配置'),
            h('span', { style: S.dim }, '写入 settings.yaml（user 层）· 保存后桥接热重载')),
          remote && draft ? h('div', null,
              CONFIG_GROUPS.map(renderGroup),
              h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginTop: '4px' }) },
                h('span', { style: changedFields.length ? S.ok : S.dim },
                  changedFields.length ? ('有 ' + changedFields.length + ' 个顶层字段待保存：' + changedFields.join(', ')) : '与远程配置一致'),
                h('div', { style: S.row },
                  h('button', { style: S.btn, disabled: saving || !changedFields.length, onClick: discard }, '放弃更改'),
                  h('button', { style: Object.assign({}, S.btnPrimary, (saving || !changedFields.length) ? { opacity: .5 } : null), disabled: saving || !changedFields.length, onClick: save },
                    saving ? '写入中…' : '保存修改'))),
              msg ? h('div', { style: msg.kind === 'ok' ? S.ok : S.err, marginTop: '6px' }, (msg.kind === 'ok' ? '✓ ' : '✗ ') + msg.text) : null,
              h('div', { style: Object.assign({}, S.dim, { marginTop: '8px' }) },
                '提示：QQ 官方机器人（qqofficial）现经 webhook 实例接入——回调填开放平台地址、format=custom 解析；完整官方适配器（Ed25519 验签 + openapi 回发）在路线图中。总开关在「运行状态」页。'))
              : h('div', { style: S.dim }, '加载配置中…'))
      }

      // ————————————————————————— Tab 3：内置指令 —————————————————————————

      var COMMANDS = [
        { cmd: '/help', desc: '显示全部命令' },
        { cmd: '/status', desc: '当前绑定会话' },
        { cmd: '/new', ph: '初始提示词（可空）', desc: '新建会话' },
        { cmd: '/reset', desc: '重置会话（清空上下文）' },
        { cmd: '/sessions', desc: '列出全部会话', admin: true },
        { cmd: '/switch', ph: 'sessionId', desc: '切换活动会话', admin: true },
        { cmd: '/gc', ph: '[分钟]', desc: '清理闲置路由', admin: true },
        { cmd: '/model', ph: '[provider/]model', desc: '查看/切换模型', admin: true },
      ]

      function CommandsTab() {
        var base = useWebchatBase()
        var sk = React.useState('console')
        var sessionKey = sk[0], setSessionKey = sk[1]
        var li = React.useState('')
        var line = li[0], setLine = li[1]
        var lg = React.useState([])
        var log = lg[0], setLog = lg[1]
        var sb = React.useState(false)
        var busy = sb[0], setBusy = sb[1]
        var listRef = React.useRef(null)

        React.useEffect(function () {
          if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
        }, [log])

        function exec(text) {
          var t = (text || '').trim()
          if (!t || t[0] !== '/' || busy) return
          setBusy(true); setLine('')
          setLog(function (prev) { return prev.concat([{ cmd: t, state: 'running', at: Date.now() }]).slice(-100) })
          fetchJson(base + '/send', {
            method: 'POST',
            body: JSON.stringify({ text: t, sender_id: 'webui-console', session_key: (sessionKey || '').trim() || 'console', wait: true }),
          }).then(function (res) {
            var replies = ((res && res.replies) || []).map(function (r) { return typeof r === 'string' ? r : ((r && r.text) != null ? r.text : JSON.stringify(r)) })
            setLog(function (prev) {
              var next = prev.slice()
              for (var i = next.length - 1; i >= 0; i--) {
                if (next[i].cmd === t && next[i].state === 'running') { next[i] = Object.assign({}, next[i], { state: 'done', replies: replies }); break }
              }
              return next
            })
          }).catch(function (e) {
            setLog(function (prev) {
              var next = prev.slice()
              for (var i = next.length - 1; i >= 0; i--) {
                if (next[i].cmd === t && next[i].state === 'running') { next[i] = Object.assign({}, next[i], { state: 'error', error: String((e && e.message) || e) }); break }
              }
              return next
            })
          }).finally(function () { setBusy(false) })
        }

        return h('div', null,
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: '8px' }) },
            h('span', { style: S.title }, '内置指令'),
            h('span', { style: S.dim }, '经 webchat 命令链路执行（对齐 AstrBot 内置指令）')),
          h('div', {
            ref: listRef,
            style: { height: '240px', overflowY: 'auto', border: '1px solid rgba(127,127,127,.25)', borderRadius: '8px', padding: '8px 10px', marginBottom: '8px', background: 'rgba(127,127,127,.05)' },
          }, log.length === 0 ? h('div', { style: S.dim }, '点击下方指令卡或直接输入 / 命令') : log.map(function (e, i) {
            return h('div', { key: i, style: S.logRow },
              h('div', { style: S.mono }, '$ ' + e.cmd + '   ' + (e.state === 'running' ? '⏳ 执行中' : fmtTime(e.at))),
              e.state === 'done' ? (e.replies.length ? e.replies.map(function (r, j) {
                return h('div', { key: j, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '2px 0 2px 10px', borderLeft: '2px solid rgba(63,185,80,.4)' } }, r)
              }) : h('div', { style: S.dim, padding: '2px 0 2px 10px' }, '（无输出）')) : null,
              e.state === 'error' ? h('div', { style: S.err, padding: '2px 0 2px 10px' }, '✗ ' + e.error) : null)
          })),
          h('div', { style: S.row, marginBottom: '8px' },
            h('span', { style: S.dim }, '会话键'),
            h('input', { style: Object.assign({}, S.input, { maxWidth: '180px' }), value: sessionKey, onChange: function (e) { setSessionKey(e.target.value) } }),
            h('input', {
              style: Object.assign({}, S.input, { fontFamily: 'ui-monospace,Menlo,Consolas,monospace' }),
              value: line, placeholder: '/status 或 /model ai/gpt-5.6 …（Enter 执行）',
              onChange: function (e) { setLine(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') exec(line) },
            }),
            h('button', { style: S.btnPrimary, disabled: busy || !line.trim(), onClick: function () { exec(line) } }, busy ? '…' : '执行')),
          h('div', { style: S.grid }, COMMANDS.map(function (c) {
            return h('button', {
              key: c.cmd, style: S.chip,
              onClick: function () { setLine(c.ph ? c.cmd + ' ' : c.cmd) },
            },
              h('div', null,
                h('span', { style: { fontWeight: 700, fontFamily: 'ui-monospace,Menlo,Consolas,monospace' } }, c.cmd),
                c.admin ? h('span', { style: Object.assign({}, S.pillOff, { marginLeft: '6px', fontSize: '10px' }) }, '管理员') : null),
              h('div', { style: S.dim }, (c.ph ? c.cmd + ' ' + c.ph + ' — ' : '') + c.desc))
          })))
      }

      // ————————————————————————— Tab 4：聊天测试 —————————————————————————

      function ChatTab() {
        var base = useWebchatBase()
        var sk = React.useState('console')
        var sessionKey = sk[0], setSessionKey = sk[1]
        var tt = React.useState('')
        var text = tt[0], setText = tt[1]
        var im = React.useState('')
        var imgUrls = im[0], setImgUrls = im[1]
        var mm = React.useState([])
        var msgs = mm[0], setMsgs = mm[1]
        var ss = React.useState(false)
        var sending = ss[0], setSending = ss[1]
        var sinceRef = React.useRef(Date.now())
        var listRef = React.useRef(null)

        function append(m) { setMsgs(function (prev) { return prev.concat([m]).slice(-200) }) }
        React.useEffect(function () {
          if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
        }, [msgs])

        function keyTrimmed() { return (sessionKey || '').trim() || 'console' }

        function sendNow() {
          var t = (text || '').trim()
          if (!t || sending) return
          setSending(true); setText('')
          append({ kind: 'out', text: t, at: Date.now() })
          var images = (imgUrls || '').split(/[\s,，]+/).map(function (s) { return s.trim() })
            .filter(function (u) { return /^(https?:\/\/|data:image\/)/i.test(u) })
          fetchJson(base + '/send', {
            method: 'POST',
            body: JSON.stringify(Object.assign({
              text: t,
              sender_id: 'webui-console',
              session_key: keyTrimmed(),
              wait: true,
            }, images.length ? { images: images } : {})),
          }).then(function (res) {
            var replies = (res && res.replies) || []
            if (!replies.length) append({ kind: 'sys', text: '（无回复：确认 webchat 渠道已启用，且 allowFrom 已放行 webui-console）', at: Date.now() })
            replies.forEach(function (r) {
              append({ kind: 'in', text: typeof r === 'string' ? r : ((r && r.text) != null ? r.text : JSON.stringify(r)), at: Date.now() })
            })
          }).catch(function (e) {
            append({ kind: 'sys', text: '发送失败：' + String((e && e.message) || e), at: Date.now() })
          }).finally(function () { setSending(false) })
        }

        function pollNow() {
          fetchJson(base + '/poll?session_key=' + encodeURIComponent(keyTrimmed()) + '&since=' + sinceRef.current)
            .then(function (res) {
              var fresh = ((res && res.messages) || []).filter(function (m) { return m.ts > sinceRef.current })
              fresh.forEach(function (m) {
                append({ kind: 'in', text: m.text, at: m.ts })
                sinceRef.current = Math.max(sinceRef.current, m.ts)
              })
              if (!fresh.length) append({ kind: 'sys', text: '（暂无新消息）', at: Date.now() })
            })
            .catch(function (e) { append({ kind: 'sys', text: '轮询失败：' + String((e && e.message) || e), at: Date.now() }) })
        }

        return h('div', null,
          h('div', { style: S.row, marginBottom: '8px' },
            h('span', { style: S.dim }, '会话键'),
            h('input', { style: S.input, value: sessionKey, onChange: function (e) { setSessionKey(e.target.value) }, placeholder: 'console（不同键=不同桥接会话）' }),
            h('button', { style: S.btn, onClick: pollNow }, '读取新消息')),
          h('div', {
            ref: listRef,
            style: { display: 'flex', flexDirection: 'column', gap: '6px', height: '250px', overflowY: 'auto', border: '1px solid rgba(127,127,127,.25)', borderRadius: '8px', padding: '10px', marginBottom: '8px', background: 'rgba(127,127,127,.05)' },
          }, msgs.length === 0 ? h('div', { style: S.dim }, '发一条消息开始测试（wait=true，回合结束整包返回）') :
            msgs.map(function (m, i) {
              var style = Object.assign({}, S.bubbleBase,
                m.kind === 'out' ? S.bubbleOut : (m.kind === 'sys' ? S.bubbleSys : S.bubbleIn))
              return h('div', { key: i, style: style },
                m.kind !== 'sys' ? h('div', { style: { fontSize: '10.5px', opacity: .5, marginBottom: '2px' } }, (m.kind === 'out' ? '我 ' : 'Bot ') + fmtTime(m.at)) : null,
                m.text)
            })),
          h('input', {
            style: Object.assign({}, S.input, { marginBottom: '6px' }),
            value: imgUrls, onChange: function (e) { setImgUrls(e.target.value) },
            placeholder: '图片 URL（可选，逗号分隔；支持 https 外链或 data:image/* —— 走入站图片落库链路）',
          }),
          h('textarea', {
            style: Object.assign({}, S.input, { minHeight: '58px', resize: 'vertical', marginBottom: '6px' }),
            value: text,
            onChange: function (e) { setText(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow() } },
            placeholder: '输入消息，Enter 发送（Shift+Enter 换行）……',
          }),
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, disabled: sending || !(text || '').trim(), onClick: sendNow }, sending ? '等待回复…' : '发送'),
            h('span', { style: S.dim }, 'webchat 路径：' + base)))
      }

      // ————————————————————————— Tab 5：扫码登录（个人微信） —————————————————————————

      function QrLoginTab() {
        var st = React.useState(null)
        var status = st[0], setStatus = st[1]
        var sb = React.useState(false)
        var busy = sb[0], setBusy = sb[1]
        var sm = React.useState('')
        var msg = sm[0], setMsg = sm[1]
        var bust = React.useState(Date.now())
        var bustV = bust[0], setBust = bust[1]
        var imgErr = React.useState(false)
        var imgBroken = imgErr[0], setImgErr = imgErr[1]

        var refreshStatus = React.useCallback(function () {
          return fetchJson('/dsh-omnibridge/weixin_oc/login-status').then(function (j) {
            setStatus(j); setMsg('')
            if (j && j.hasQr) setImgErr(false)
          }).catch(function (e) {
            var text = String((e && e.message) || e)
            if (text.indexOf('404') !== -1) {
              setStatus({ unavailable: true })
              setMsg('')
              return
            }
            setStatus(null)
            setMsg('状态查询失败：' + text)
          })
        }, [])
        React.useEffect(function () { refreshStatus() }, [refreshStatus])
        React.useEffect(function () {
          var t = setInterval(refreshStatus, 4000)
          return function () { clearInterval(t) }
        }, [refreshStatus])

        function refreshQr() {
          if (busy) return
          setBusy(true)
          fetchJson('/dsh-omnibridge/weixin_oc/qr-refresh', { method: 'POST', body: '{}' })
            .then(function (r) {
              if (r && r.loggedIn) { setMsg('已登录，无需刷新二维码') }
              else if (r && r.ok) { setBust(Date.now()); setMsg('') }
              else { setMsg('二维码获取失败（iLink 接口异常），稍后再试') }
              return refreshStatus()
            })
            .catch(function (e) { setMsg('刷新失败：' + String((e && e.message) || e)) })
            .finally(function () { setBusy(false) })
        }

        var loggedIn = !!(status && status.loggedIn)
        var unavailable = !!(status && status.unavailable)
        var statePill = unavailable ? { text: '个人微信未开启', on: false }
          : loggedIn ? { text: '已登录', on: true }
          : (status && status.loggingIn) ? { text: '登录流程进行中…等待扫码', on: true }
          : { text: '待扫码（点击「刷新二维码」获取）', on: false }

        function relogin() {
          if (busy) return
          if (!window.confirm('将清除当前个人微信登录态并生成新二维码，需要用手机重新扫码确认。\n旧 token 会备份到 weixin_oc.state.json（previousToken）。继续？')) return
          setBusy(true)
          fetchJson('/dsh-omnibridge/weixin_oc/qr-refresh', { method: 'POST', body: JSON.stringify({ restart: true }) })
            .then(refreshStatus)
            .catch(function (e) { setMsg('操作失败：' + String((e && e.message) || e)) })
            .finally(function () { setBusy(false) })
        }

        return h('div', null,
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: '8px' }) },
            h('span', { style: S.title }, '个人微信扫码登录'),
            h('div', { style: S.row },
              h(Pill, { on: statePill.on, text: statePill.text }),
              h('button', { style: S.btn, onClick: refreshStatus }, '↻ 刷新状态'))),
          msg ? h('div', { style: S.err, marginBottom: '6px' }, msg) : null,
          unavailable ? h('div', null,
            h('div', { style: Object.assign({}, S.dim, { marginBottom: '10px' }) },
              '个人微信没开，这里不会出二维码。大肥鱼的 QQ 不用在这一页扫码，去「运行状态」看 QQ 是否开着。'),
            ScanSection(),
            h(OtherPlatformsCard))
          : loggedIn ? h('div', { style: S.panel },
            h('div', { style: S.ok }, '✓ 个人微信已登录（token 有效）'),
            h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) },
              '收发消息正常工作中。如需更换账号或登录态失效，点下方按钮重新扫码。'),
            h('button', { style: Object.assign({}, S.btn, { marginTop: '8px' }), disabled: busy, onClick: relogin },
              busy ? '处理中…' : '退出并重新扫码'))
            : h('div', null,
              h('div', { style: Object.assign({}, S.row, { alignItems: 'flex-start', gap: '16px' }) },
                h('div', {
                  style: { border: '1px solid rgba(127,127,127,.3)', borderRadius: '10px', padding: '10px', background: '#fff', width: '260px', height: '260px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
                },
                  status && status.hasQr && !imgBroken
                    ? h('img', {
                        src: (status.qrUrl || '/dsh-omnibridge/weixin_oc/qrcode.png') + '?bust=' + bustV,
                        alt: '个人微信登录二维码',
                        width: 240, height: 240,
                        onError: function () { setImgErr(true) },
                      })
                    : h('div', { style: { color: '#888', fontSize: '12px', textAlign: 'center' } }, imgBroken ? '二维码加载失败\n点击「刷新二维码」重取' : '暂无二维码\n点击「刷新二维码」获取')),
                h('div', { style: { flex: 1, minWidth: '200px' } },
                  h('button', { style: Object.assign({}, S.btnPrimary, busy ? { opacity: .5 } : null), disabled: busy, onClick: refreshQr },
                    busy ? '获取中…' : '⟳ 刷新二维码'),
                  h('div', { style: Object.assign({}, S.dim, { marginTop: '8px' }) },
                    '用个人微信扫码并在手机上确认登录。'),
                  h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) },
                    status && status.qrUpdatedAt ? ('当前二维码更新于 ' + fmtTime(status.qrUpdatedAt) + '；二维码过期后登录流程会自动轮换（最多 3 次），也可手动刷新。') : '登录流程运行时每张二维码有效期约 5 分钟。'),
                  h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) },
                    '扫码成功后此处状态会自动变为「已登录」（4 秒内），无需重启。'),
                  ScanSection(),
                  h(OtherPlatformsCard)))))
      }

      // ————————————————————————— 微信客服（企业微信）二维码卡 —————————————————————————

      function WecomKfCard() {
        var st = React.useState({ corpId: '', secret: '', kfName: '' })
        var form = st[0], setForm = st[1]
        var sb = React.useState(false)
        var busy = sb[0], setBusy = sb[1]
        var sm = React.useState(null)
        var msg = sm[0], setMsg = sm[1]
        var qr = React.useState(null)
        var qrUrl = qr[0], setQrUrl = qr[1]

        function fetchQr() {
          if (busy) return
          if (!form.corpId || !form.secret) { setMsg('请填写 corpId 与微信客服 secret'); return }
          setBusy(true); setMsg(null)
          fetchJson('/dsh-omnibridge/scan/wecom-kf', { method: 'POST', body: JSON.stringify({ corpId: form.corpId, secret: form.secret, kfName: form.kfName }) })
            .then(function (r) { setQrUrl(r.url); setMsg('') })
            .catch(function (e) { setMsg('获取失败：' + String((e && e.message) || e)) })
            .finally(function () { setBusy(false) })
        }

        return h('div', { style: Object.assign({}, S.panel, { margin: '8px 0 0' }) },
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            h('span', { style: S.title }, '微信客服（企业微信）'),
            qrUrl ? h(Pill, { on: true, text: '二维码就绪' }) : null),
          h('div', { style: S.dim }, '填企业微信 corpId + 微信客服 secret，生成「联系客服」二维码；微信扫码添加后，客服消息经企微回调进入桥接。'),
          h('div', { style: S.grid },
            h(FieldRow, { spec: { f: 'corpId', label: 'corpId' }, value: form.corpId, onChange: function (v) { setForm(Object.assign({}, form, { corpId: v })) } }),
            h(FieldRow, { spec: { f: 'secret', label: '微信客服 secret', type: 'secret' }, value: form.secret, onChange: function (v) { setForm(Object.assign({}, form, { secret: v })) } }),
            h(FieldRow, { spec: { f: 'kfName', label: '客服账号名（可选，默认第一个）' }, value: form.kfName, onChange: function (v) { setForm(Object.assign({}, form, { kfName: v })) } })),
          h('button', { style: Object.assign({}, S.btnPrimary, busy ? { opacity: .5 } : null), disabled: busy, onClick: fetchQr },
            busy ? '获取中…' : '获取客服二维码'),
          msg ? h('div', { style: S.err, marginTop: '6px' }, msg) : null,
          qrUrl ? h('div', { style: Object.assign({}, S.row, { alignItems: 'flex-start', gap: '14px', marginTop: '8px' }) },
            h('div', { style: { border: '1px solid rgba(127,127,127,.3)', borderRadius: '10px', padding: '8px', background: '#fff', width: '184px', height: '184px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
              h('img', {
                src: 'https://api.qrserver.com/v1/create-qr-code/?size=168x168&margin=2&data=' + encodeURIComponent(qrUrl),
                alt: '微信客服二维码', width: 168, height: 168,
              })),
            h('div', { style: { flex: 1, minWidth: '180px' } },
              h('div', { style: S.dim }, '微信扫码添加该客服；对话消息需配合企微回调（渠道配置 wecom 实例）接收。'),
              h('button', { style: S.btn, onClick: function () { window.open(qrUrl, '_blank') } }, '打开客服链接 ↗')))
          : null)
      }

      // ————————————————————————— Tab 6：其他平台说明 —————————————————————————

      // ————————————————————————— 平台扫码接入（飞书/钉钉/QQ 官方） —————————————————————————

      var SCAN_PRESETS = [
        { platform: 'feishu', name: '飞书', desc: 'PersonalAgent 设备码授权：飞书 App 扫码确认后自动创建应用并回传 app_id / app_secret' },
        { platform: 'dingtalk', name: '钉钉', desc: 'DingTalk 设备码授权：扫码确认后自动创建钉钉应用并回传 client_id / client_secret' },
        { platform: 'qqofficial', name: 'QQ 官方机器人', desc: 'q.qq.com 绑定任务：QQ 扫码确认后回传 AppID / AppSecret（AES-GCM 加密传输，本端解密）' },
      ]

      function ScanRegistrationCard(props) {
        var preset = props.preset
        var st = React.useState(null)
        var session = st[0], setSession = st[1]
        var sb = React.useState(false)
        var busy = sb[0], setBusy = sb[1]
        var sm = React.useState(null)
        var msg = sm[0], setMsg = sm[1]
        var ps = React.useState('')
        var pollStatus = ps[0], setPollStatus = ps[1]
        var sc = React.useState(null)
        var created = sc[0], setCreated = sc[1]

        function begin() {
          if (busy) return
          setBusy(true); setMsg(null); setCreated(null); setPollStatus('')
          fetchJson('/dsh-omnibridge/scan/begin', { method: 'POST', body: JSON.stringify({ platform: preset.platform }) })
            .then(function (r) { setSession(r.session) })
            .catch(function (e) { setMsg('发起失败：' + String((e && e.message) || e)) })
            .finally(function () { setBusy(false) })
        }

        React.useEffect(function () {
          if (!session || created) return undefined
          var stopped = false
          var timer = null
          var tick = function () {
            if (stopped) return
            fetchJson('/dsh-omnibridge/scan/poll', {
              method: 'POST',
              body: JSON.stringify({ platform: preset.platform, session: session }),
            }).then(function (r) {
              if (stopped) return
              if (r.status === 'created') { setCreated({ appId: r.appId, appSecret: r.appSecret }); setPollStatus(''); return }
              if (r.status === 'pending') setPollStatus('等待扫码确认…')
              else if (r.status === 'slow_down') setPollStatus(r.message || '（限速，已自动放缓）')
              else if (r.status === 'denied') { setPollStatus('已取消'); setSession(null); return }
              else if (r.status === 'expired') { setPollStatus(r.message || '已过期，请重新发起'); setSession(null); return }
              else setPollStatus(r.message || r.status)
              timer = setTimeout(tick, Math.max(2, session.interval || 5) * 1000)
            }).catch(function (e) {
              if (stopped) return
              setPollStatus('轮询失败：' + String((e && e.message) || e))
              timer = setTimeout(tick, 8000)
            })
          }
          tick()
          return function () { stopped = true; if (timer) clearTimeout(timer) }
        }, [session, created])

        function copyText(text) {
          try { navigator.clipboard.writeText(text) } catch (e) {}
        }

        var qrSrc = session ? (session.qrSrc || '') : ''
        return h('div', { style: Object.assign({}, S.panel, { margin: '8px 0 0' }) },
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            h('span', { style: S.title }, preset.name),
            created ? h(Pill, { on: true, text: '已创建' }) : (session ? h(Pill, { on: false, text: '等待扫码' }) : null)),
          h('div', { style: S.dim }, preset.desc),
          msg ? h('div', { style: S.err, marginTop: '6px' }, msg) : null,
          created ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: S.ok }, '✓ 凭证已获取'),
              h('div', { style: Object.assign({}, S.mono, { marginTop: '4px' }) }, 'app_id: ' + created.appId),
              h('div', { style: Object.assign({}, S.mono, { marginTop: '2px' }) }, 'app_secret: ' + created.appSecret.slice(0, 6) + '…',
                h('button', { style: Object.assign({}, S.btn, { marginLeft: '8px' }), onClick: function () { copyText(created.appSecret) } }, '复制')),
              h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) }, '在「渠道配置」' + preset.name + '卡填入并保存；对应收发适配器接入后自动使用。'))
            : session ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: Object.assign({}, S.row, { alignItems: 'flex-start', gap: '16px' }) },
                h('div', { style: { border: '1px solid rgba(127,127,127,.3)', borderRadius: '10px', padding: '8px', background: '#fff', width: '184px', height: '184px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                  h('img', {
                    src: 'https://api.qrserver.com/v1/create-qr-code/?size=168x168&margin=2&data=' + encodeURIComponent(qrSrc),
                    alt: preset.name + ' 授权二维码', width: 168, height: 168,
                  })),
                h('div', { style: { flex: 1, minWidth: '180px' } },
                  session.userCode ? h('div', { style: Object.assign({}, S.row, { marginBottom: '4px' }) },
                    h('span', { style: { fontWeight: 700, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: '14px' } }, session.userCode),
                    h('button', { style: S.btn, onClick: function () { copyText(session.userCode) } }, '复制')) : null,
                  h('div', { style: Object.assign({}, S.dim, { marginBottom: '6px' }) }, '用对应 App 扫左侧二维码，或打开授权页确认。'),
                  h('div', { style: S.row },
                    h('button', { style: S.btn, onClick: function () { window.open(qrSrc, '_blank') } }, '打开授权页 ↗'),
                    h('button', { style: S.btn, onClick: begin }, '重新发起')),
                  h('div', { style: Object.assign({}, S.dim, { marginTop: '6px' }) }, pollStatus || '已发起，等待扫码确认…'))))
            : h('button', { style: Object.assign({}, S.btnPrimary, busy ? { opacity: .5 } : null), disabled: busy, onClick: begin },
              busy ? '发起中…' : '开始扫码接入'))
      }

      function ScanSection() {
        return h('div', { style: Object.assign({}, S.panel, { marginTop: '10px' }) },
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
            h('span', { style: S.title }, '平台扫码接入'),
            h('span', { style: S.dim }, '设备码授权 · 凭证回传后填入渠道配置')),
          SCAN_PRESETS.map(function (p) { return h(ScanRegistrationCard, { key: p.platform, preset: p }) }),
          h(WecomKfCard))
      }

      function OtherPlatformsCard() {
        return h('div', { style: Object.assign({}, S.panel, { marginTop: '10px' }) },
          h('div', { style: S.title }, '无扫码环节的平台'),
          h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) },
            '企业微信 / LINE / 微信公众号 / Telegram / Satori 使用 Token 或 AppId+Secret 鉴权，不存在扫码环节——凭据在「渠道配置」对应平台卡填写即可。飞书 / 钉钉 / QQ 官方已支持上方设备码扫码接入。'),
          h('div', { style: Object.assign({}, S.dim, { marginTop: '8px' }) },
            'QQ 的登录、目录和扫码在「NapCat」页完成。'))
      }

      // ————————————————————————— 主面板（settings.section 挂载） —————————————————————————

      /** 渲染错误边界：子组件崩溃时把错误显示在面板上（而不是整块空白）。 */
      var PanelBoundary = class extends React.Component {
        constructor(props) { super(props); this.state = { err: null } }
        static getDerivedStateFromError(err) { return { err: err } }
        render() {
          if (this.state.err) {
            return h('div', { style: S.err },
              '面板渲染异常：' + (this.state.err.message || '') + '\n' +
              String(this.state.err.stack || '').slice(0, 500))
          }
          return this.props.children
        }
      }

      function NapCatTab() {
        var cfgSt = React.useState(null)
        var cfg = cfgSt[0], setCfg = cfgSt[1]
        var dirSt = React.useState('')
        var dir = dirSt[0], setDir = dirSt[1]
        var uinSt = React.useState('')
        var uin = uinSt[0], setUin = uinSt[1]
        var autoSt = React.useState(false)
        var auto = autoSt[0], setAuto = autoSt[1]
        var cwdSt = React.useState('')
        var cwd = cwdSt[0], setCwd = cwdSt[1]
        var presetSt = React.useState('standard')
        var preset = presetSt[0], setPreset = presetSt[1]
        var ownerSt = React.useState('')
        var owners = ownerSt[0], setOwners = ownerSt[1]
        var allowSt = React.useState('')
        var allow = allowSt[0], setAllow = allowSt[1]
        var adminSt = React.useState('')
        var admins = adminSt[0], setAdmins = adminSt[1]
        var wakeSt = React.useState(true)
        var wakeOn = wakeSt[0], setWakeOn = wakeSt[1]
        var wakeWordSt = React.useState('大肥鱼')
        var wakeWords = wakeWordSt[0], setWakeWords = wakeWordSt[1]
        var voiceSt = React.useState(true)
        var voice = voiceSt[0], setVoice = voiceSt[1]
        var portSt = React.useState('3001')
        var port = portSt[0], setPort = portSt[1]
        var tokenSt = React.useState('')
        var tokenInput = tokenSt[0], setTokenInput = tokenSt[1]
        var maxSt = React.useState('2000')
        var maxChars = maxSt[0], setMaxChars = maxSt[1]
        var bodySt = React.useState(null)
        var body = bodySt[0], setBody = bodySt[1]
        var msgSt = React.useState(null)
        var msg = msgSt[0], setMsg = msgSt[1]
        var busySt = React.useState(false)
        var busy = busySt[0], setBusy = busySt[1]
        var uinTouched = React.useRef(false)
        var dirTouched = React.useRef(false)

        function splitList(value) {
          return String(value || '').split(/\n|,|，/).map(function (item) { return item.trim() }).filter(Boolean)
        }
        var load = React.useCallback(function () {
          return fetchJson(SETTINGS_API).then(function (next) {
            var onebot = next.onebot || {}
            var portMatch = /:(\d+)/.exec(onebot.url || '')
            setCfg(next)
            setAuto(!!onebot.autoStart)
            setCwd(next.cwd || '')
            setPreset(next.agentPreset || 'standard')
            setOwners(Array.isArray(onebot.ownerIds) ? onebot.ownerIds.join('\n') : '')
            setAllow(Array.isArray(next.allowFrom) ? next.allowFrom.join('\n') : '')
            setAdmins(Array.isArray(next.admins) ? next.admins.join('\n') : '')
            setWakeOn(onebot.groupAtOnly !== false)
            setWakeWords(Array.isArray(onebot.groupWakeWords) && onebot.groupWakeWords.length ? onebot.groupWakeWords.join('、') : '大肥鱼')
            setVoice(onebot.voiceReply !== false)
            setPort(portMatch ? portMatch[1] : '3001')
            setMaxChars(String(next.maxMessageChars || 2000))
            if (!dirTouched.current) setDir(function (current) { return onebot.napcatDir || current || '' })
            if (!uinTouched.current) setUin(function (current) { return onebot.loginUin || current || '' })
          }).catch(function (error) { setMsg({ kind: 'err', text: error.message || String(error) }) })
        }, [])
        React.useEffect(function () { load() }, [load])
        React.useEffect(function () {
          var stop = false
          function tick() {
            fetchJson('/dsh-omnibridge/qq-body').then(function (j) { if (!stop) setBody(j) }).catch(function () {})
          }
          tick()
          var timer = setInterval(tick, 4000)
          return function () { stop = true; clearInterval(timer) }
        }, [])
        React.useEffect(function () {
          if (uinTouched.current || uin) return
          if (body && body.uin) setUin(body.uin)
        }, [body, uin])
        React.useEffect(function () {
          if (dirTouched.current || dir) return
          var found = (body && (body.runningDir || body.rememberedDir)) || ''
          if (found) setDir(found)
        }, [body, dir])

        function nextUrl() {
          var previous = (cfg && cfg.onebot && cfg.onebot.url) || ''
          var token = tokenInput.trim()
          if (!token) {
            var match = /access_token=([^&]*)/.exec(previous)
            token = match ? decodeURIComponent(match[1]) : ' '
          }
          return 'ws://127.0.0.1:' + (Number(port) || 3001) + '?access_token=' + encodeURIComponent(token)
        }
        function persist(overrides) {
          var patch = overrides || {}
          var loginUin = patch.loginUin != null ? String(patch.loginUin).trim() : uin.trim()
          var napcatDir = patch.napcatDir != null ? String(patch.napcatDir).trim() : dir.trim()
          var previousRate = (cfg && cfg.rateLimit) || {}
          var onebot = Object.assign({}, (cfg && cfg.onebot) || {}, {
            napcatDir: napcatDir,
            autoStart: !!auto,
            loginUin: loginUin,
            groupAtOnly: !!wakeOn,
            groupWakeWords: splitList(wakeWords.replace(/、/g, '\n')),
            ownerIds: splitList(owners),
            voiceReply: !!voice,
            url: nextUrl(),
          })
          return fetchJson(SETTINGS_API, {
            method: 'POST',
            body: JSON.stringify({ patch: {
              onebot: onebot,
              cwd: cwd.trim(),
              agentPreset: preset || 'standard',
              allowFrom: splitList(allow),
              admins: splitList(admins),
              maxMessageChars: Number(maxChars) || 2000,
              rateLimit: Object.assign({}, previousRate, { maxPerMinute: Number(previousRate.maxPerMinute) || 0 }),
            } }),
          }).then(function (next) { setCfg(next); setTokenInput(''); return next })
        }
        function act(action, extra) {
          return fetchJson('/dsh-omnibridge/qq-body', {
            method: 'POST',
            body: JSON.stringify(Object.assign({ action: action, napcatDir: dir.trim(), loginUin: uin.trim() }, extra || {})),
          })
        }
        function finish(promise, okText) {
          if (busy || !cfg) return
          setBusy(true)
          setMsg(null)
          promise.then(function (j) {
            if (j && j.label) setBody(j)
            if (j && j.error) setMsg({ kind: 'err', text: j.error })
            else if (j && j.ok === false) setMsg({ kind: 'err', text: j.error || '没有完成' })
            else if (okText) setMsg({ kind: 'ok', text: okText })
          }).catch(function (error) {
            setMsg({ kind: 'err', text: error.message || String(error) })
          }).then(function () { setBusy(false) })
        }
        function save() {
          finish(persist().then(function () { return { ok: true } }), dir.trim() ? '已保存。' : '已保存。还没选文件夹，这里还不能登录。')
        }
        function login(fresh) {
          if (!dir.trim()) { setMsg({ kind: 'err', text: '先选择 NapCat 的文件夹。' }); return }
          var readyNow = body && (body.state === 'ready' || body.qqRunning || body.listening)
          finish(persist().then(function () {
            return act(fresh && readyNow ? 'switch' : 'start', { fresh: !!fresh, loginUin: fresh ? '' : uin.trim() })
          }), fresh ? '正在换号。要扫码的话，二维码会出现在下面。' : '正在登录。')
        }
        function useAccount(nextUin) {
          if (!window.confirm('换成 ' + nextUin + ' 会关掉当前 QQ 窗口。你自己的 QQ 如果开在同一个窗口里，也会一起退出。')) return
          uinTouched.current = true
          setUin(nextUin)
          if (!dir.trim()) { setMsg({ kind: 'err', text: '先选择 NapCat 的文件夹。' }); return }
          finish(persist({ loginUin: nextUin }).then(function () { return act('switch', { fresh: false, loginUin: nextUin }) }), '正在换成 ' + nextUin + '。')
        }
        function logout() {
          if (!window.confirm('退出后肥鱼会离线。这台电脑的 QQ 是同一个窗口，你自己的 QQ 也会一起退出。记住的号还留着。')) return
          finish(act('logout'), '已退出。')
        }
        function pick() {
          if (busy) return
          setBusy(true)
          setMsg({ kind: 'ok', text: '正在打开文件夹窗口。如果被挡住了，到任务栏点一下。' })
          fetchJson('/dsh-omnibridge/qq-body/pick', { method: 'POST', body: '{}' }).then(function (j) {
            if (j && j.dir) { dirTouched.current = true; setDir(j.dir); setMsg({ kind: 'ok', text: '已经选好。点保存。' }) }
            else if (j && j.canceled) setMsg(null)
            else setMsg({ kind: 'err', text: (j && j.error) || '没有选到 NapCat' })
          }).catch(function (error) {
            setMsg({ kind: 'err', text: error.message || String(error) })
          }).then(function () { setBusy(false) })
        }
        function useRunning() {
          if (!body || !body.runningDir) return
          dirTouched.current = true
          setDir(body.runningDir)
          finish(persist({ napcatDir: body.runningDir }), '已改用正在运行的那个目录。')
        }

        var link = (body && body.link) || {}
        var ready = body && body.state === 'ready'
        var who = body && body.uin ? ((body.nick ? body.nick + ' · ' : '') + body.uin) : ''
        var suggest = body && body.runningDir && body.runningDir !== dir.trim()
        var accounts = (body && body.accounts) || []
        var heard = link.lastHeard
        var qqLine = body ? (body.state === 'starting' ? '正在打开' : (body.qqRunning ? '窗口在' : '没开')) : '查看中…'
        var loginLine = !body ? '查看中…' : (ready ? ('已登录' + (who ? ' ' + who : '')) : (body.qr ? '等待扫码' : '未登录'))
        var serviceLine = body ? (body.listening ? '已开' : '没开') : '查看中…'
        var brainLine = link.connected ? '已接上' : (link.reconnecting ? '正在重连' : '未接上')
        var installBusy = !!(body && body.install && body.install.busy)
        var installHave = !!(body && body.installed)
        var installText = '正在下载…'
        if (installBusy && body.install.phase === 'checking') installText = '正在查找版本…'
        else if (installBusy && body.install.phase === 'unpacking') installText = '正在解开…'
        else if (installBusy && body.install.percent) installText = '正在下载 ' + body.install.percent + '%'
        return h('div', null,
          h('div', { style: S.panel },
            h('div', { style: S.title }, '概况'),
            h('div', { style: Object.assign({}, S.dim, { margin: '4px 0 8px' }) }, 'DeepSeek 是她本人。这一页是她的身体。你在 QQ 里跟她说话。'),
            infoLine('QQ', qqLine),
            infoLine('登录', loginLine),
            infoLine('服务', serviceLine),
            infoLine('DeepSeek', brainLine),
            body && body.webToken ? h('div', { style: Object.assign({}, S.row, { padding: '3px 0' }) },
              h('span', { style: { opacity: .6, minWidth: '110px', fontSize: '12px' } }, '网页登录口令'),
              h('span', { style: Object.assign({}, S.mono, { wordBreak: 'break-all' }) }, body.webToken),
              h('button', {
                style: S.btn,
                onClick: function () {
                  var text = body.webToken
                  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () {
                    setMsg({ kind: 'ok', text: '网页登录口令已复制。' })
                  }).catch(function () { setMsg({ kind: 'err', text: '没有复制成功，请手动选中这段口令。' }) })
                },
              }, '复制')) : h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) }, '还没找到网页登录口令。先选好 NapCat 文件夹。'),
            h('div', { style: Object.assign({}, S.dim, { marginTop: '2px' }) }, '点打开网页会直接进入。如果还停在登录页，把上面这段贴进 Token。'),
            body && body.listening && !link.connected ? h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) }, 'QQ 已经开着，DeepSeek 还没接上。点重新连接。') : null,
            body && body.error ? h('div', { style: Object.assign({}, S.err, { marginTop: '6px' }) }, body.error) : null,
            h('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
              h('button', { style: S.btn, disabled: busy, onClick: function () { finish(act('reconnect'), '正在重新连接。') } }, '重新连接'),
              h('button', { style: S.btn, disabled: busy, onClick: function () { finish(act('show'), '已把 QQ 窗口调到前面。') } }, '显示窗口'),
              h('button', { style: S.btn, disabled: busy, onClick: function () { finish(act('web'), '已在浏览器打开。') } }, '打开网页'),
              h('button', { style: S.btnDanger, disabled: busy, onClick: logout }, '退出登录'))),
          h('div', { style: S.panel },
            h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between' }) },
              h('span', { style: S.title }, '登录'),
              h(Pill, { on: !!ready, text: (body && body.label) || '查看中…' })),
            ready
              ? h('div', { style: { marginTop: '8px', fontSize: '15px', fontWeight: 700 } }, who || 'QQ 已连上')
              : h('div', { style: Object.assign({}, S.dim, { marginTop: '6px' }) }, '用记住的号进入，或在这里扫码。登录过的号会出现在下面。'),
            body && body.qr ? h('div', { style: { marginTop: '10px' } },
              h('img', {
                alt: 'QQ 登录二维码',
                src: '/dsh-omnibridge/qq-body/qrcode?bust=' + body.qrAt,
                style: { width: '180px', height: '180px', background: '#fff', borderRadius: '8px' },
              }),
              h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) }, '用手机 QQ 扫这个码。扫完这里会变成已登录。')) : null,
            accounts.length ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: S.fieldLabel }, '登录过的号'),
              h('div', { style: S.row }, accounts.map(function (item) {
                var label = (item.nick ? item.nick + ' · ' : '') + item.uin
                return h('button', { key: item.uin, style: S.chip, disabled: busy, onClick: function () { useAccount(item.uin) } }, label)
              }))) : null,
            h('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
              ready ? null : h('button', {
                style: Object.assign({}, S.btnPrimary, (busy || !dir.trim()) ? { opacity: .5 } : null),
                disabled: busy || !dir.trim(),
                onClick: function () { login(false) },
              }, uin.trim() ? '用这个号登录' : '登录'),
              h('button', {
                style: Object.assign({}, S.btn, (busy || !dir.trim()) ? { opacity: .5 } : null),
                disabled: busy || !dir.trim(),
                onClick: function () { login(true) },
              }, '扫码登录'))),
          h('div', { style: S.panel },
            h('div', { style: S.title }, '配置'),
            h('div', { style: S.fieldLabel }, 'NapCat 文件夹'),
            h('div', { style: S.row },
              h('input', {
                style: Object.assign({}, S.input, { flex: '1 1 220px' }),
                value: dir,
                placeholder: '已有的选文件夹；没有就点下面准备身体',
                onChange: function (event) { dirTouched.current = true; setDir(event.target.value) },
              }),
              h('button', { style: S.btn, disabled: busy, onClick: pick }, '选择文件夹')),
            installBusy
              ? h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
                h('span', { style: S.dim }, installText),
                h('button', { style: S.btn, onClick: function () { finish(act('cancel-install'), '已取消。') } }, '取消'))
              : (installHave
                ? h('div', { style: Object.assign({}, S.dim, { marginTop: '6px' }) }, '身体已经在这个文件夹里，不用再装。')
                : h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
                  h('button', {
                    style: S.btnPrimary,
                    disabled: busy,
                    onClick: function () { finish(act('install'), '正在准备身体。') },
                  }, '准备身体'),
                  h('span', { style: S.dim }, '下载开源 NapCat，里面带着 QQ。'))),
            suggest ? h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
              h('span', { style: S.dim }, '正在运行的是 ' + body.runningDir),
              h('button', { style: S.btn, disabled: busy, onClick: useRunning }, '改用这个')) : null,
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '登录的 QQ 号'),
            h('input', {
              style: S.input,
              value: uin,
              placeholder: '留空就扫码',
              onChange: function (event) { uinTouched.current = true; setUin(event.target.value.replace(/\D/g, '').slice(0, 12)) },
            }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '工作目录'),
            h('input', { style: S.input, value: cwd, placeholder: '她改代码时用的文件夹', onChange: function (event) { setCwd(event.target.value) } }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '她怎么干活'),
            h(EnumSelect, {
              spec: { options: [
                { value: 'standard', label: 'standard · 搜索、改文件、跑命令' },
                { value: 'minimal', label: 'minimal · 只聊天' },
                { value: 'ptc', label: 'ptc · 搜索和命令，外加更复杂的调用' },
                { value: 'cordis', label: 'cordis · 改 DeepSeek 插件用' },
              ] },
              value: preset,
              onChange: setPreset,
            }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '主人 QQ'),
            h('textarea', { style: Object.assign({}, S.input, { minHeight: '46px' }), value: owners, onChange: function (event) { setOwners(event.target.value) } }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '谁可以给她发消息'),
            h('textarea', { style: Object.assign({}, S.input, { minHeight: '46px' }), value: allow, placeholder: '一行一个。空着就是谁的消息都不收', onChange: function (event) { setAllow(event.target.value) } }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '管理员'),
            h('textarea', { style: Object.assign({}, S.input, { minHeight: '46px' }), value: admins, placeholder: '空着则上面的人都能用管理指令', onChange: function (event) { setAdmins(event.target.value) } }),
            h('div', { style: Object.assign({}, S.row, { marginTop: '10px', justifyContent: 'space-between' }) },
              h('span', null, '群里要 @ 或喊醒才回'),
              h('button', { style: S.switch(wakeOn), onClick: function () { setWakeOn(!wakeOn) } }, wakeOn ? '开' : '关')),
            h('input', { style: Object.assign({}, S.input, { marginTop: '6px' }), value: wakeWords, onChange: function (event) { setWakeWords(event.target.value) } }),
            h('div', { style: Object.assign({}, S.row, { marginTop: '10px', justifyContent: 'space-between' }) },
              h('span', null, '私聊默认回语音'),
              h('button', { style: S.switch(voice), onClick: function () { setVoice(!voice) } }, voice ? '开' : '关')),
            h('div', { style: Object.assign({}, S.row, { marginTop: '10px', justifyContent: 'space-between' }) },
              h('span', null, '打开 DeepSeek 时自动登录'),
              h('button', { style: S.switch(auto), onClick: function () { setAuto(!auto) } }, auto ? '开' : '关')),
            h('div', { style: Object.assign({}, S.dim, { marginTop: '6px' }) }, '关掉 DeepSeek 时，NapCat 和这个 QQ 会一起退出，不会再自己留在后台。'),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '端口'),
            h('input', { style: S.input, value: port, onChange: function (event) { setPort(event.target.value.replace(/\D/g, '').slice(0, 5)) } }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '口令'),
            h('input', { type: 'password', style: S.input, value: tokenInput, placeholder: body && body.tokenSet ? '已设置，留空则不改' : '没有口令。要设就填在这里', onChange: function (event) { setTokenInput(event.target.value) } }),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '单条回复最多多少字'),
            h('input', { style: S.input, value: maxChars, onChange: function (event) { setMaxChars(event.target.value.replace(/\D/g, '').slice(0, 6)) } }),
            h('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
              h('button', { style: S.btnPrimary, disabled: busy || !cfg, onClick: save }, busy ? '处理中…' : '保存')),
            msg ? h('div', { style: Object.assign({}, msg.kind === 'err' ? S.err : S.ok, { marginTop: '8px' }) }, msg.text) : null),
          h('div', { style: S.panel },
            h('div', { style: S.title }, '调试'),
            h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
              h('button', { style: S.btnPrimary, disabled: busy, onClick: function () { finish(act('probe'), '已发给主人：测试。我在。') } }, '给主人发一句测试')),
            heard ? h('div', { style: Object.assign({}, S.dim, { marginTop: '8px' }) }, '刚收到 ' + (heard.from || '') + '：' + heard.text) : h('div', { style: Object.assign({}, S.dim, { marginTop: '8px' }) }, '用手机给这个号发一句，这句话会出现在这里。'),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '她能听懂的指令'),
            h('div', { style: S.dim }, '/help 能问什么　/new 新开一轮　/status 这轮用了多少'),
            h('div', { style: S.dim }, '/model 换模型　/think 思考强度　/balance 账户余额'),
            h('div', { style: Object.assign({}, S.dim, { marginTop: '4px' }) }, '在 QQ 里发给她就行。'),
            h('div', { style: Object.assign({}, S.fieldLabel, { marginTop: '10px' }) }, '最近记录'),
            h('div', {
              style: Object.assign({}, S.mono, { whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto', marginTop: '4px' }),
            }, (body && body.log && body.log.length) ? body.log.join('\n') : '还没有记录。')))
      }

      function BridgePanel() {
        return h(PanelBoundary, null, h(NapCatTab))
      }

      // ————————————————————————— 插件卡（settings.plugin.item） —————————————————————————

      function PluginItemCard() {
        var st = React.useState(null)
        var data = st[0], setData = st[1]
        var sb = React.useState(false)
        var busy = sb[0], setBusy = sb[1]

        var refresh = React.useCallback(function () {
          return fetchJson(STATUS_API).then(setData).catch(function () {})
        }, [])
        React.useEffect(function () { refresh() }, [refresh])

        function toggle() {
          if (busy) return
          setBusy(true)
          postEnabled(!(data && data.enabled)).then(refresh).finally(function () { setBusy(false) })
        }

        var channels = (data && data.channels) || []
        var running = channels.filter(function (c) { return c.enabled }).length
        var summary = data && data.summary

        return h('div', { style: S.panel },
          h('div', { style: Object.assign({}, S.row, { justifyContent: 'space-between', marginBottom: '6px' }) },
            h('span', { style: { fontWeight: 700 } }, '大肥鱼'),
            h(Pill, { on: !!(data && data.enabled), text: data && data.enabled ? 'ON' : 'OFF' })),
          h('div', { style: Object.assign({}, S.dim, { marginBottom: '6px' }) },
            channels.length ? (running + '/' + channels.length + ' 渠道运行 · ' + (summary ? summary.routes : 0) + ' 条路由') : '状态未知（API 未响应）'),
          h(EnabledToggleRow, { enabled: !!(data && data.enabled), onDone: refresh }),
          h('div', { style: Object.assign({}, S.dim, { marginTop: '6px' }) },
            'QQ 身体在设置页的「消息桥」里。'))
      }

      // ————————————————————————— apply：slot 注册入口 —————————————————————————

      function realApply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
          console.warn('[dsh-omnibridge:client] ctx.slots 不可用，跳过 WebUI 注入')
          return
        }

        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: NS,
              order: 62,
              label: function () { return '消息桥' },
            }, BridgePanel)
          })
        }, NS + ': settings.section')

        ctx.effect(function () {
          return ctx.slots.inject('settings.plugin.item', function () {
            return ctx.slots.register({
              name: 'settings.plugin.item',
              key: NS,
              id: NS,
              order: 30,
              label: function () { return '消息桥' },
            }, PluginItemCard)
          })
        }, NS + ': settings.plugin.item')
      }

      exports.apply = function apply(ctx) {
        try {
          realApply(ctx)
        } catch (error) {
          console.warn('[dsh-omnibridge:client] apply 失败（WebUI 注入跳过）:', error && error.stack || error)
        }
      }

      exports.inject = ['slots']
      return module.exports
    },
  })
})()
