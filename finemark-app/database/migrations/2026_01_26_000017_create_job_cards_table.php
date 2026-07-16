<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('job_cards', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('installation_request_id')->constrained('installation_requests')->cascadeOnDelete();
            $table->foreignUuid('assignment_id')->nullable()->constrained('assignments')->nullOnDelete();
            $table->foreignUuid('technician_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('status')->default('open')->index();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->text('notes')->nullable();
            $table->jsonb('metadata')->nullable();
            $table->timestamps();

            $table->index(['installation_request_id', 'technician_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('job_cards');
    }
};
