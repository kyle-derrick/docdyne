-- 056：分享水印默认关闭（v7.11）。
-- 根因：shares.watermark_enabled 列 DEFAULT TRUE + Go 零值 false —— gorm 在
-- INSERT 时把未显式赋值的 false 省略，落库被列默认改写为 true（"没勾选
-- 水印却出现水印"）。改列默认 false；公开分享由服务层强制不加水印（公开
-- 访客无用户身份，水印无意义），私有分享仍可显式开启。幂等。
ALTER TABLE shares ALTER COLUMN watermark_enabled SET DEFAULT FALSE;
