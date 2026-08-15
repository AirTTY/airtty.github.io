	# 插入位置:容器 target/linux/ath79/tiny/base-files/etc/board.d/01_leds
	# 2026-07-23:綠=link、橘=tx/rx,一律綁 eth1(實體網孔;carrier 跟線)。
	# 舊版綁 br-lan 永遠亮(橋著 eth0=CPU 側恆 up);LED 名用現代 color:function
	# (green:lan / orange:lan),否則 04_led_migration 的 remove_devicename_leds
	# 會把 uci sysfs 剝成對不上的名字、觸發器永遠掛不上。
	gigastone,a4-52er|\
	gigastone,a4-52er-stock)
		ucidef_set_led_netdev "lan_link" "LAN-LINK" "green:lan" "eth1" "link"
		ucidef_set_led_netdev "lan_act" "LAN-ACT" "orange:lan" "eth1" "tx rx"
		;;
