## tdx-guest-aux

```
apt-get update
apt-get install -y build-essential linux-headers-$(uname -r) gcc-12
make CC=gcc-12
insmod tdx_guest_aux.ko
./tdx_user
```