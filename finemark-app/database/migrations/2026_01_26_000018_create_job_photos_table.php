<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('job_photos', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('job_card_id')->constrained('job_cards')->cascadeOnDelete();
            $table->foreignUuid('uploaded_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('storage_disk')->default('s3');
            $table->string('path');
            $table->string('caption')->nullable();
            $table->timestamp('taken_at')->nullable();
            $table->jsonb('metadata')->nullable();
            $table->timestamps();

            $table->index('job_card_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('job_photos');
    }
};
