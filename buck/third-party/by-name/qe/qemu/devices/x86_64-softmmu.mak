# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Device selection for qemu-system-x86_64, resolved by minikconf in
# --allnoconfig mode: nothing is enabled unless named here or selected by
# something that is. Stands in for configs/devices/x86_64-softmmu/default.mak.
#
# There is no i440fx "pc" machine, QEMU's default for x86_64, so pass
# "-M q35" (or "-M microvm") explicitly.

CONFIG_Q35=y
CONFIG_MICROVM=y

# Paravirtual devices. Every machine here has a PCI(e) host bridge, so these
# are the virtio-*-pci devices; the virt machines also get virtio-mmio
# transports from their own Kconfig selects.
CONFIG_VIRTIO_PCI=y
CONFIG_VIRTIO_BALLOON=y
CONFIG_VIRTIO_BLK=y
CONFIG_VIRTIO_GPU=y
CONFIG_VIRTIO_INPUT=y
CONFIG_VIRTIO_NET=y
CONFIG_VIRTIO_RNG=y
CONFIG_VIRTIO_SCSI=y
CONFIG_VIRTIO_SERIAL=y

# pcie-root-port, for hotplug and for more than a bus worth of devices.
CONFIG_PCIE_PORT=y

# Display adapters: the standard VGA the q35 machine adds by default, and
# virtio-vga, virtio-gpu with a VGA compatible framebuffer for firmware.
CONFIG_VGA_PCI=y
CONFIG_VIRTIO_VGA=y

# The HPET, which most OSes expect on a PC.
CONFIG_HPET=y

# isa-debugcon, where OVMF and other firmware print their debug log.
CONFIG_ISA_DEBUG=y

# tpm-tis, tpm-crb and the swtpm backend (-tpmdev emulator), for measured
# boot.
CONFIG_TPM_CRB=y
CONFIG_TPM_EMULATOR=y
CONFIG_TPM_TIS_ISA=y
