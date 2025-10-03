#ifndef UAPI_TDX_GUEST_AUX_H
#define UAPI_TDX_GUEST_AUX_H

#include <linux/ioctl.h>
#include <linux/types.h>

/*
 * IOCTL IDs
 */
#define TDXGA_IOC_BASE        0xF5
#define IOCTL_TDX_VP_INFO     _IOR(TDXGA_IOC_BASE, 0x01, struct tdx_vp_info_out)
#define IOCTL_TDX_SYS_RD      _IOWR(TDXGA_IOC_BASE, 0x02, struct tdx_sys_rd_arg)

/*
 * TDG.VP.INFO result (subset)
 */
struct tdx_vp_info_out {
    __u64 attributes;      /* RDX: ATTRIBUTES bitfield (check MIGRATABLE bit) */
    __u64 xfam;            /* optional (if you choose to capture it) */
    __u64 gpa_width;       /* optional (if you choose to capture it) */
    __s32 tdcall_status;   /* RAX status (0 = success per ABI) */
};

/*
 * TDG.SYS.RD one-step query
 * - Pass field_id_in = -1 to get the first field and a next_id for iteration
 * - Kernel returns field_id_out (the actual field read), value, and next_id
 */
struct tdx_sys_rd_arg {
    __s64 field_id_in;     /* IN: current id (-1 for first) */
    __s64 field_id_out;    /* OUT: id just read */
    __s64 next_id;         /* OUT: next id (-1 => end) */
    __u64 value;           /* OUT: value (R8 per ABI) */
    __s32 tdcall_status;   /* OUT: RAX status */
};

#endif /* UAPI_TDX_GUEST_AUX_H */
