<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'Billing', href: '#' },
    { label: 'Payments', href: '#' },
    { label: 'Reconciliation', href: '#' },
    { label: 'Reports', href: '#' },
];
</script>

<template>
    <DashboardLayout title="Accounts Dashboard" role-label="Accounts" :menu-items="menuItems">
        <h1 class="text-2xl font-semibold">Accounts Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Monitor billing, track payments, and reconcile accounts.
        </p>
    </DashboardLayout>
</template>
