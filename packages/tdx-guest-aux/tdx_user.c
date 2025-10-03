#include <fcntl.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include "uapi_tdx_guest_aux.h"

int main() {
    int fd = open("/dev/tdx_guest_aux", O_RDONLY);
    struct tdx_vp_info_out info = {0};
    if (ioctl(fd, IOCTL_TDX_VP_INFO, &info) == 0) {
	printf("ATTRIBUTES=0x%016llx, status=%d\n",
	       (unsigned long long)info.attributes, info.tdcall_status);
    }

    struct tdx_sys_rd_arg s = {.field_id_in = -1};
    while (ioctl(fd, IOCTL_TDX_SYS_RD, &s) == 0 && s.tdcall_status == 0) {
	printf("field= %lld  value=0x%016llx  next=%lld\n",
	       (long long)s.field_id_out, (unsigned long long)s.value, (long long)s.next_id);
	if (s.next_id == -1) break;
	s.field_id_in = s.next_id;
    }
    return 0;
}
