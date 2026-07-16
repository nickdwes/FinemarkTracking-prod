<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'Work Orders', href: '#' },
    { label: 'Inspections', href: '#' },
    { label: 'Maintenance Logs', href: '#' },
    { label: 'Parts Requests', href: '#' },
];
</script>

<template>
    <DashboardLayout title="Technician Dashboard" role-label="Technician" :menu-items="menuItems">
        <h1 class="text-2xl font-semibold">Technician Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Manage field tasks, inspections, and service records.
        </p>
    </DashboardLayout>
</template>
