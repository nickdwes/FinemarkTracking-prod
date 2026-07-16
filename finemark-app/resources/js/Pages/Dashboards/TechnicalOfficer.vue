<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
    { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
    { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
    { label: 'Stats', href: '#' },
];
</script>

<template>
    <DashboardLayout
        title="Technical Officer Dashboard"
        role-label="Technical Officer"
        :menu-items="menuItems"
    >
        <h1 class="text-2xl font-semibold">Technical Officer Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Review technical work, approve outcomes, and manage escalations.
        </p>
    </DashboardLayout>
</template>
