obj-m += tdx_guest_aux.o

KDIR ?= /lib/modules/$(shell uname -r)/build
PWD  := $(shell pwd)

all: modules tdx_user

modules:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

tdx_user: tdx_user.c uapi_tdx_guest_aux.h
	gcc-12 -o tdx_user tdx_user.c

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean
	rm -f tdx_user
