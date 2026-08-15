define Device/gigastone_a4-52er
  SOC := ar9331
  DEVICE_VENDOR := Gigastone
  DEVICE_MODEL := A4-52ER
  # usb-serial 全家烤進 image:extroot 的 apk db 會跨刷機遮蔽新 kernel 記錄,
  # runtime 裝 kernel 相依套件必撞 vermagic(troubleshooting 2026-07-12);
  # 烤進來則刷機自帶驅動、db 漂移無害。
  DEVICE_PACKAGES := kmod-usb-chipidea2 kmod-usb-serial kmod-usb-serial-ftdi \
	kmod-usb-serial-cp210x kmod-usb-serial-ch341 kmod-usb-serial-pl2303 \
	kmod-usb-acm
  IMAGE_SIZE := 8000k
  SUPPORTED_DEVICES += gigastone,a4-52er
endef
TARGET_DEVICES += gigastone_a4-52er

# "enshan" 2014-pepe2k U-Boot variant: same hardware, but the flash layout uses
# explicit kernel(0x20000,0x1e0000) + rootfs(0x200000,0x5f0000) partitions
# instead of a denx,uimage "firmware" partition. Needed because the enshan
# U-Boot boots a TP-Link-tag-prefixed blob (no uImage magic), so mtdsplit_uimage
# can't split rootfs. The DTS declares rootfs explicitly; kernel finds it by
# label. Keep separate from the pepe2k gigastone_a4-52er profile above.
# 整合位置:容器 tiny.mk 的 gigastone_a4-52er-stock 之後。
# See the DTS comments in ../dts/ for the rationale.
define Device/gigastone_a4-52er-enshan
  SOC := ar9331
  DEVICE_VENDOR := Gigastone
  DEVICE_MODEL := A4-52ER (enshan U-Boot)
  DEVICE_DTS := ar9331_gigastone_a4-52er-enshan
  DEVICE_PACKAGES := kmod-usb-chipidea2 kmod-usb-serial kmod-usb-serial-ftdi \
	kmod-usb-serial-cp210x kmod-usb-serial-ch341 kmod-usb-serial-pl2303 \
	kmod-usb-acm
  IMAGE_SIZE := 8000k
  SUPPORTED_DEVICES += gigastone,a4-52er
endef
TARGET_DEVICES += gigastone_a4-52er-enshan
