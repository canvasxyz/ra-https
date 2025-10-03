// SPDX-License-Identifier: MIT
// Minimal TDX guest helper: exposes TDG.VP.INFO and TDG.SYS.RD via ioctls.

#include <linux/module.h>
#include <linux/miscdevice.h>
#include <linux/fs.h>
#include <linux/uaccess.h>

#include "uapi_tdx_guest_aux.h"

/*
 * IMPORTANT: Leaf numbers come from the Intel TDX Module/ABI spec.
 * Set these to the spec-defined values you use in your environment.
 * Example (override): insmod tdx_guest_aux.ko vp_info_leaf=... sys_rd_leaf=...
 */
static unsigned long vp_info_leaf = 1;   // TDG.VP.INFO  (set appropriately)
module_param(vp_info_leaf, ulong, 0444);
MODULE_PARM_DESC(vp_info_leaf, "TDG.VP.INFO leaf number for TDCALL");

static unsigned long sys_rd_leaf   = 11;  // TDG.SYS.RD    (set appropriately)
module_param(sys_rd_leaf, ulong, 0444);
MODULE_PARM_DESC(sys_rd_leaf, "TDG.SYS.RD leaf number for TDCALL");

static unsigned long sys_rdall_leaf   = 12;  // TDG.SYS.RDALL    (set appropriately)
module_param(sys_rdall_leaf, ulong, 0444);
MODULE_PARM_DESC(sys_rdall_leaf, "TDG.SYS.RDALL leaf number for TDCALL");

/*
 * Minimal inline TDCALL wrapper for x86_64.
 * We pass/return via the standard register ABI used by TDX leaves:
 *   IN:  RAX=leaf, RCX/RDX/R8/R9/R10/R11 as per leaf spec
 *   OUT: RAX=status, other regs may return data per leaf
 *
 * Notes:
 * - The "tdcall" mnemonic is recognized by recent binutils/clang.
 *   If your toolchain doesn't know it, switch to the .byte encoding.
 */
static inline unsigned long tdcall(
	unsigned long *rax, unsigned long *rcx, unsigned long *rdx,
	unsigned long *r8,  unsigned long *r9,  unsigned long *r10,
	unsigned long *r11)
{
    register unsigned long a asm("rax") = *rax;
    register unsigned long c asm("rcx") = rcx ? *rcx : 0;
    register unsigned long d asm("rdx") = rdx ? *rdx : 0;
    register unsigned long _r8 asm("r8") = r8 ? *r8 : 0;
    register unsigned long _r9 asm("r9") = r9 ? *r9 : 0;
    register unsigned long _r10 asm("r10") = r10 ? *r10 : 0;
    register unsigned long _r11 asm("r11") = r11 ? *r11 : 0;

    asm volatile(
#if 1
        "tdcall"
#else
        /* Fallback encoding if assembler lacks 'tdcall' mnemonic.
         * Replace with the correct opcode for your toolchain if needed. */
        ".byte 0x66, 0x0F, 0x01, 0xCC"
#endif
        : "+a"(a), "+c"(c), "+d"(d), "+r"(_r8), "+r"(_r9), "+r"(_r10), "+r"(_r11)
        :
        : "memory");

    if (rax) *rax = a;
    if (rcx) *rcx = c;
    if (rdx) *rdx = d;
    if (r8)  *r8  = _r8;
    if (r9)  *r9  = _r9;
    if (r10) *r10 = _r10;
    if (r11) *r11 = _r11;

    return a; // status in RAX
}

/* ---- IOCTL handlers ---- */

static long tdxga_vp_info(struct tdx_vp_info_out __user *up)
{
    struct tdx_vp_info_out out = {0};
    unsigned long rax = vp_info_leaf, rcx = 0, rdx = 0, r8 = 0, r9 = 0, r10 = 0, r11 = 0;

    if (!vp_info_leaf)
        return -EINVAL;

    tdcall(&rax, &rcx, &rdx, &r8, &r9, &r10, &r11);

    out.tdcall_status = (int)rax;
    out.attributes    = rdx;
    out.xfam          = r8;     /* if the ABI returns XFAM here; safe to expose */
    out.gpa_width     = r9;     /* optional depending on ABI version */

    if (copy_to_user(up, &out, sizeof(out)))
        return -EFAULT;
    return 0;
}

static long tdxga_sys_rd(struct tdx_sys_rd_arg __user *uarg)
{
    struct tdx_sys_rd_arg arg;
    unsigned long rax, rcx, rdx, r8, r9 = 0, r10 = 0, r11 = 0;

    if (!sys_rd_leaf)
	return -EINVAL;

    if (copy_from_user(&arg, uarg, sizeof(arg)))
        return -EFAULT;

    /* Per TDG.SYS.RD ABI:
     *   RAX=leaf
     *   RCX=field_id_in
     * Returns:
     *   RAX=status
     *   RCX=field_id_out
     *   RDX=next_id
     *   R8 =value
     */
    rax = sys_rd_leaf;
    rcx = (unsigned long)arg.field_id_in;
    rdx = 0; r8 = 0;

    tdcall(&rax, &rcx, &rdx, &r8, &r9, &r10, &r11);

    arg.tdcall_status = (int)rax;
    arg.field_id_out  = (long)rcx;
    arg.next_id       = (long)rdx;
    arg.value         = r8;

    if (copy_to_user(uarg, &arg, sizeof(arg)))
        return -EFAULT;

    return 0;
}

static long tdxga_ioctl(struct file *f, unsigned int cmd, unsigned long arg)
{
    switch (cmd) {
    case IOCTL_TDX_VP_INFO:
        return tdxga_vp_info((struct tdx_vp_info_out __user *)arg);
    case IOCTL_TDX_SYS_RD:
        return tdxga_sys_rd((struct tdx_sys_rd_arg __user *)arg);
    default:
        return -ENOIOCTLCMD;
    }
}

static const struct file_operations tdxga_fops = {
    .owner          = THIS_MODULE,
    .unlocked_ioctl = tdxga_ioctl,
#ifdef CONFIG_COMPAT
    .compat_ioctl   = tdxga_ioctl,
#endif
};

static struct miscdevice tdxga_dev = {
    .minor = MISC_DYNAMIC_MINOR,
    .name  = "tdx_guest_aux",
    .fops  = &tdxga_fops,
    .mode  = 0600, /* root-only by default; change if needed */
};

static int __init tdxga_init(void)
{
    int ret = misc_register(&tdxga_dev);
    if (ret) {
        pr_err("tdx_guest_aux: misc_register failed: %d\n", ret);
        return ret;
    }
    pr_info("tdx_guest_aux: loaded (vp_info_leaf=%lu, sys_rd_leaf=%lu)\n",
            vp_info_leaf, sys_rd_leaf);
    return 0;
}

static void __exit tdxga_exit(void)
{
    misc_deregister(&tdxga_dev);
    pr_info("tdx_guest_aux: unloaded\n");
}

MODULE_DESCRIPTION("Minimal Intel TDX guest helper for VP.INFO and SYS.RD");
MODULE_AUTHOR("Canvas Technologies, Inc.");
MODULE_LICENSE("MIT");

module_init(tdxga_init);
module_exit(tdxga_exit);
