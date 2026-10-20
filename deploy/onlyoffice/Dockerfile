# OnlyOffice DocumentServer + 中文字体：
# 官方镜像不含 CJK 字体，中文文档在查看/编辑与格式转换（x2t）中会渲染
# 为方块乱码（fc-list :lang=zh 为空）。叠加 fonts-noto-cjk 后 fontconfig
# 即可命中中文字形；presentationthemeeditor 字体表由部署后执行一次
# documentserver-generate-allfont 重建（结果落 onlyoffice_data 卷持久）。
#
# apt 源处理（2026-10 用户服务器实测踩坑，三层因素叠加）：
# 1) 基座（Ubuntu 22.04 jammy）apt 的 https 传输方法在部分 CPU 上 SIGILL
#    崩溃（"Method https has died unexpectedly / signal 4"）——任何残留
#    的 https 源行都会炸掉 apt-get update；
# 2) 基座自带的第三方源（sources.list.d/ 的 onlyoffice/mssql 仓库等）
#    走 https，同样触发；
# 3) 镜像内的源形态不可控（官方 http / 阿里云 https 皆有可能）。
# 因此不逐行替换，而是无差别重写：sources.list 固定为 http 阿里云四组件
#（jammy 主仓/更新/安全/回退；包完整性由 GPG 签名保证，http 无安全降级），
# sources.list.d/ 整体挪开、装完还原（运行期不跑 apt，还原仅为镜像忠实）。
# 阿里云不可达时整体回退官方源（archive.ubuntu.com 亦承载 -security）。
FROM onlyoffice/documentserver:8.2.3

RUN mkdir -p /tmp/apt-extra \
    && if [ -d /etc/apt/sources.list.d ]; then mv /etc/apt/sources.list.d/* /tmp/apt-extra/ 2>/dev/null || true; fi \
    && printf '%s\n' \
        'deb http://mirrors.aliyun.com/ubuntu jammy main restricted universe multiverse' \
        'deb http://mirrors.aliyun.com/ubuntu jammy-updates main restricted universe multiverse' \
        'deb http://mirrors.aliyun.com/ubuntu jammy-security main restricted universe multiverse' \
        'deb http://mirrors.aliyun.com/ubuntu jammy-backports main restricted universe multiverse' \
        > /etc/apt/sources.list \
    && (apt-get update \
        || (echo 'aliyun mirror failed, falling back to official sources' \
            && sed -i 's|http://mirrors.aliyun.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list \
            && apt-get update)) \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && if [ -d /etc/apt/sources.list.d ]; then mv /tmp/apt-extra/* /etc/apt/sources.list.d/ 2>/dev/null || true; fi \
    && rm -rf /var/lib/apt/lists/*
