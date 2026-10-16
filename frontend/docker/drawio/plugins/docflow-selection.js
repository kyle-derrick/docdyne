/**
 * DocDyne drawio 选区跟踪插件（v7.15 D1）。
 *
 * 官方 embed 协议（proto=json postMessage）不发送选中事件（drawio 27.x
 * app.min.js 实测：父页可收事件仅 init/autosave/save/export/exit/load/
 * configure/template/merge/draft/resize/prompt/textContent/remoteInvoke*），
 * 故由本插件补齐：监听画布选区变更，向宿主页上报
 *   {event:'select', cells:[cellId,...]}
 * 宿主 DrawioPage 据此维护 selectedCellIdsRef（get_selection 工具与
 * AI 选区上下文）。
 *
 * 加载链路（全部为 drawio 官方自托管定制点，机制经 vendored 27.0.9 包体核实）：
 *  - frontend/Dockerfile 把本文件 COPY 进 drawio webapp 的 plugins/ 目录；
 *  - js/PreConfig.js 追加 window.ALLOW_CUSTOM_PLUGINS=true（app.min.js 解析
 *    时读取）；
 *  - 宿主页（同源）把 'plugins/docdyne-selection.js' 写入 drawio 本地设置
 *    （.drawio-config 的 plugins 列表，DrawioPage.enableSelectionPlugin），
 *    drawio 启动时经 mxscript 同域加载并执行 Draw.loadPlugin 回调。
 *
 * ES5 语法（与 drawio 自带插件一致），无外部依赖。
 */
Draw.loadPlugin(function (ui) {
  var graph = ui.editor.graph
  var last = ''
  graph.getSelectionModel().addListener(mxEvent.CHANGE, function () {
    try {
      var cells = graph.getSelectionCells()
      var ids = []
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].id != null) ids.push(String(cells[i].id))
      }
      var payload = JSON.stringify({ event: 'select', cells: ids })
      // CHANGE 可在同选区下重复触发（如撤销/重做），按内容去重。
      if (payload !== last) {
        last = payload
        parent.postMessage(payload, '*')
      }
    } catch (e) {
      // 上报失败静默——不影响编辑功能
    }
  })
})
