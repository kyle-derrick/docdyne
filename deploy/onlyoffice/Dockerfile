# OnlyOffice DocumentServer + 中文字体：
# 官方镜像不含 CJK 字体，中文文档在查看/编辑与格式转换（x2t）中会渲染
# 为方块乱码（fc-list :lang=zh 为空）。叠加 fonts-noto-cjk 后 fontconfig
# 即可命中中文字形；presentationthemeeditor 字体表由部署后执行一次
# documentserver-generate-allfont 重建（结果落 onlyoffice_data 卷持久）。
# apt 源替换为阿里云镜像（国内网络直连 archive.ubuntu.com 间歇失败）：
# 必须用 http——基座（Ubuntu 20.04）apt 的 https 传输方法在部分 CPU 上
# SIGILL 崩溃（"Method https has died unexpectedly / signal 4"，2026-10
# 用户服务器实测）；http 源包完整性同样由 GPG 签名校验保证。镜像失败时
# 自动回退官方源再试（备份 sources.list）。
FROM onlyoffice/documentserver:8.2.3

RUN cp /etc/apt/sources.list /etc/apt/sources.list.orig \
    && sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list \
    && (apt-get update \
        || (echo 'aliyun mirror failed, falling back to official sources' \
            && cp /etc/apt/sources.list.orig /etc/apt/sources.list \
            && apt-get update)) \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -f /etc/apt/sources.list.orig \
    && rm -rf /var/lib/apt/lists/*
