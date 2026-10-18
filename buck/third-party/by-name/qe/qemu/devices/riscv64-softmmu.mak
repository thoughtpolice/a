# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Device selection for qemu-system-riscv64, resolved by minikconf in
# --allnoconfig mode: nothing is enabled unless named here or selected by
# something that is. Stands in for configs/devices/riscv64-softmmu/default.mak.

CONFIG_RISCV_VIRT=y

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

# tpm-tis-device and the swtpm backend (-tpmdev emulator), for measured boot.
CONFIG_TPM_EMULATOR=y
CONFIG_TPM_TIS_SYSBUS=y
