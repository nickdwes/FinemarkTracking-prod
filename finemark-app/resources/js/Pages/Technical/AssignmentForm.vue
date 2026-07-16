<template>
    <DashboardLayout title="Assignment Form" role-label="Technical Officer" :menu-items="menuItems">
        <h1 class="text-2xl font-semibold">Assignment Form</h1>
        <p class="mt-2 text-sm text-slate-600">Assign a technician to a pending request.</p>

        <div class="mt-4 text-sm text-slate-600">
            Select a request and technician, then submit to create an assignment.
        </div>

        <div class="mt-6 rounded-xl border border-slate-200 bg-white p-6">
            <form class="space-y-4" @submit.prevent="submitAssignment">
                <div>
                    <label class="text-sm font-medium text-slate-700">Pending Request</label>
                    <select
                        v-model="form.requestId"
                        class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    >
                        <option value="" disabled>Select a request</option>
                        <option v-for="request in pendingRequests" :key="request.id" :value="request.id">
                            {{ request.customer_name }} - {{ request.registration_number }}
                        </option>
                    </select>
                    <p class="mt-1 text-xs text-slate-400" v-if="pendingRequests.length === 0">
                        No pending requests found.
                    </p>
                </div>

                <div>
                    <label class="text-sm font-medium text-slate-700">Technician</label>
                    <select
                        v-model="form.technicianId"
                        class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    >
                        <option value="" disabled>Select a technician</option>
                        <option v-for="tech in technicians" :key="tech.id" :value="tech.id">
                            {{ tech.name }} ({{ tech.email }})
                        </option>
                    </select>
                </div>

                <div>
                    <label class="text-sm font-medium text-slate-700">Scheduled At</label>
                    <input
                        v-model="form.scheduledAt"
                        type="datetime-local"
                        class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                </div>

                <div>
                    <label class="text-sm font-medium text-slate-700">Notes</label>
                    <textarea
                        v-model="form.notes"
                        rows="3"
                        class="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                        placeholder="Optional notes"
                    ></textarea>
                </div>

                <div class="flex flex-wrap items-center gap-3">
                    <button
                        type="submit"
                        class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
                        :disabled="submitting"
                    >
                        {{ submitting ? 'Assigning...' : 'Assign Technician' }}
                    </button>
                    <button type="button" class="text-sm text-slate-500" @click="loadData">Refresh lists</button>
                </div>

                <div v-if="message" class="text-sm text-green-600">{{ message }}</div>
                <div v-if="error" class="text-sm text-red-600">{{ error }}</div>
            </form>
        </div>
    </DashboardLayout>
</template>

<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';
import { onMounted, reactive, ref } from 'vue';

const menuItems = [
    { label: 'Pending Requests', href: route('technical.pending'), name: 'technical.pending' },
    { label: 'Assignment Form', href: route('technical.assign'), name: 'technical.assign' },
    { label: 'Assignments', href: route('technical.assignments'), name: 'technical.assignments' },
];

const pendingRequests = ref([]);
const technicians = ref([]);
const submitting = ref(false);
const message = ref('');
const error = ref('');

const form = reactive({
    requestId: '',
    technicianId: '',
    scheduledAt: '',
    notes: '',
});

const loadData = async () => {
    error.value = '';
    message.value = '';

    try {
        const [requestsResponse, techResponse] = await Promise.all([
            window.axios.get('/api/technical/pending-requests'),
            window.axios.get('/api/technical/technicians'),
        ]);

        pendingRequests.value = requestsResponse.data?.data?.items ?? [];
        technicians.value = techResponse.data?.data?.items ?? [];
    } catch (err) {
        error.value = err?.response?.data?.error?.message || 'Failed to load assignment data.';
    }
};

const submitAssignment = async () => {
    if (!form.requestId || !form.technicianId) {
        error.value = 'Please select a request and technician.';
        return;
    }

    submitting.value = true;
    error.value = '';
    message.value = '';

    try {
        const response = await window.axios.post(`/api/technical/assign/${form.requestId}`, {
            technician_id: form.technicianId,
            scheduled_at: form.scheduledAt || null,
            notes: form.notes || null,
        });

        if (response.data?.success) {
            message.value = 'Assignment created successfully.';
            form.requestId = '';
            form.technicianId = '';
            form.scheduledAt = '';
            form.notes = '';
            await loadData();
        } else {
            error.value = response.data?.error?.message || 'Failed to assign technician.';
        }
    } catch (err) {
        error.value = err?.response?.data?.error?.message || 'Failed to assign technician.';
    } finally {
        submitting.value = false;
    }
};

onMounted(loadData);
onMounted(() => {
    const requestId = new URLSearchParams(window.location.search).get('requestId');
    if (requestId) {
        form.requestId = requestId;
    }
});
</script>
