<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('certificate_reviews', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('certificate_id')->constrained('certificates')->cascadeOnDelete();
            $table->foreignUuid('maker_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUuid('checker_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('status')->default('pending')->index();
            $table->text('remarks')->nullable();
            $table->timestamp('reviewed_at')->nullable();
            $table->timestamps();

            $table->index(['certificate_id', 'status', 'maker_id', 'checker_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('certificate_reviews');
    }
};
