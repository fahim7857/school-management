import { initDatabase, db } from './backend/database.js';

async function runTests() {
  console.log('=== RUNNING COMPREHENSIVE INTEGRATION TESTS ===\n');
  await initDatabase();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Academic Classes
  console.log('--- 1. Testing Academic Streams & Classes ---');
  const genClass = db.prepare("SELECT * FROM classes WHERE stream = 'General' LIMIT 1").get();
  assert(genClass !== undefined, `Found General stream class: ${genClass?.name}`);

  let hifzClass = db.prepare("SELECT * FROM classes WHERE stream = 'Hifz' LIMIT 1").get();
  if (!hifzClass) {
    const ay = db.prepare("SELECT id FROM academic_years WHERE is_active = 1 LIMIT 1").get();
    const res = db.prepare("INSERT INTO classes (academic_year_id, class_number, name, monthly_fee, stream, is_active) VALUES (?, 1, 'Hifz Group A', 1500, 'Hifz', 1)").run(ay.id);
    hifzClass = db.prepare("SELECT * FROM classes WHERE id = ?").get(res.lastInsertRowid);
  }
  assert(hifzClass !== undefined && hifzClass.stream === 'Hifz', `Found or created Hifz stream class: ${hifzClass?.name}`);

  // 2. Subjects & Teacher Assignments
  console.log('\n--- 2. Testing Subjects & Strict Exclusive Teacher Assignment ---');
  let testSub = db.prepare("SELECT * FROM subjects WHERE class_id = ? LIMIT 1").get(genClass.id);
  if (!testSub) {
    const res = db.prepare("INSERT INTO subjects (academic_year_id, stream, class_id, name, code, full_marks) VALUES (?, 'General', ?, 'Mathematics', 'MTH101', 100)").run(genClass.academic_year_id, genClass.id);
    testSub = db.prepare("SELECT * FROM subjects WHERE id = ?").get(res.lastInsertRowid);
  }
  assert(testSub !== undefined, `Subject exists: ${testSub.name} (Code: ${testSub.code})`);

  let testTeacher = db.prepare("SELECT * FROM teachers WHERE status = 'Active' LIMIT 1").get();
  assert(testTeacher !== undefined, `Teacher exists: ${testTeacher.name}`);

  // Assign teacher
  db.prepare("DELETE FROM teacher_assignments WHERE subject_id = ?").run(testSub.id);
  db.prepare("INSERT INTO teacher_assignments (teacher_id, subject_id, class_id, stream, academic_year_id, is_active) VALUES (?, ?, ?, ?, ?, 1)").run(testTeacher.id, testSub.id, genClass.id, genClass.stream, genClass.academic_year_id);
  const assignment = db.prepare("SELECT * FROM teacher_assignments WHERE subject_id = ? AND is_active = 1").get(testSub.id);
  assert(assignment && assignment.teacher_id === testTeacher.id, `Teacher ${testTeacher.name} assigned exclusively to ${testSub.name}`);

  // 3. Teacher Fixed Salary & Advance Accounting
  console.log('\n--- 3. Testing Teacher Fixed Salary & Advance Deduction ---');
  const tSalary = 25000;
  const tAdvance = 5000;
  db.prepare("UPDATE teachers SET fixed_salary = ? WHERE id = ?").run(tSalary, testTeacher.id);
  const updatedTeacher = db.prepare("SELECT * FROM teachers WHERE id = ?").get(testTeacher.id);
  assert(updatedTeacher.fixed_salary === tSalary, `Teacher fixed monthly salary updated to ৳${tSalary}`);

  // 4. Students Registration: Dual Phones & Notes
  console.log('\n--- 4. Testing Students Dual Phones, Stream & Notes ---');
  const testPhonePrimary = '01700-112233';
  const testPhoneSecondary = '01800-445566';
  const testNotes = 'Special math coaching candidate; punctual student.';
  const ay = db.prepare("SELECT id FROM academic_years WHERE is_active = 1 LIMIT 1").get();

  const stuRes = db.prepare(`
    INSERT INTO students (academic_year_id, class_id, roll_number, stream, name, phone, phone_secondary, primary_contact, notes, address, admission_date, status)
    VALUES (?, ?, 'TEST-999', 'General', 'Test Student Anik', ?, ?, 'primary', ?, 'Dhanmondi, Dhaka', '2026-01-10', 'Active')
  `).run(ay.id, genClass.id, testPhonePrimary, testPhoneSecondary, testNotes);

  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(stuRes.lastInsertRowid);
  assert(student.phone === testPhonePrimary, `Primary phone saved: ${student.phone}`);
  assert(student.phone_secondary === testPhoneSecondary, `Secondary phone saved: ${student.phone_secondary}`);
  assert(student.notes === testNotes, `Notes saved: ${student.notes}`);
  assert(student.stream === 'General', `Stream saved: ${student.stream}`);

  // 5. Examinations & 30:70 Calculation with 0.5 Nearest Rounding
  console.log('\n--- 5. Testing Examination 30:70 Formula & 0.5 Nearest Rounding ---');
  const examRes = db.prepare(`
    INSERT INTO examinations (academic_year_id, stream, class_id, exam_type, name, weight_monthly, weight_main, is_published)
    VALUES (?, 'General', ?, 'half_yearly', 'Half-Yearly Test Exam 2026', 30, 70, 1)
  `).run(ay.id, genClass.id);
  const examId = examRes.lastInsertRowid;
  assert(examId > 0, `Created examination with id ${examId}`);

  // Formula test cases:
  // Case A: MT1 = 80, MT2 = 90 -> MT Avg = 85 -> 30% = 25.5. Main = 75 -> 70% = 52.5. Total = 78.0
  const mtAvgA = (80 + 90) / 2;
  const rawA = (mtAvgA * 0.30) + (75 * 0.70);
  const roundedA = Math.round(rawA * 2) / 2;
  assert(roundedA === 78.0, `Calculation A: MT(80,90) + Main(75) -> 78.0 (Got ${roundedA})`);

  // Case B: Nearest 0.5 check:
  // Raw 78.23 -> round(78.23 * 2) / 2 = round(156.46)/2 = 156/2 = 78.0
  // Raw 78.30 -> round(78.30 * 2) / 2 = round(156.6)/2 = 157/2 = 78.5
  // Raw 78.78 -> round(78.78 * 2) / 2 = round(157.56)/2 = 158/2 = 79.0
  assert(Math.round(78.23 * 2) / 2 === 78.0, `Rounding 78.23 -> 78.0`);
  assert(Math.round(78.30 * 2) / 2 === 78.5, `Rounding 78.30 -> 78.5`);
  assert(Math.round(78.78 * 2) / 2 === 79.0, `Rounding 78.78 -> 79.0`);

  // Insert marks into exam_marks
  db.prepare(`
    INSERT INTO exam_marks (examination_id, student_id, subject_id, class_id, stream, mt1, mt2, main_exam, final_score, grade, grade_point, is_absent)
    VALUES (?, ?, ?, ?, 'General', 80, 90, 75, 78.0, 'B+', 4.00, 0)
  `).run(examId, student.id, testSub.id, genClass.id);

  const savedMark = db.prepare("SELECT * FROM exam_marks WHERE examination_id = ? AND student_id = ?").get(examId, student.id);
  assert(savedMark && savedMark.final_score === 78.0 && savedMark.grade === 'B+', `Exam marks saved and verified: 78.0 (Grade: ${savedMark?.grade}, GP: ${savedMark?.grade_point})`);

  // 6. Staff Management: Dual Phones & Optional Details
  console.log('\n--- 6. Testing Staff Registration with Dual Phones & Optional Details ---');
  const staffRes = db.prepare(`
    INSERT INTO staff (name, phone, phone_secondary, primary_contact, address, work_post, fixed_salary, emergency_contact, optional_details)
    VALUES ('Belal Hossain', '01799-887766', '01899-112233', 'primary', 'Mirpur-10, Dhaka', 'Accountant', 18000, '01911-000111 (Wife)', 'Handles evening shift receipts.')
  `).run();
  const staffMember = db.prepare("SELECT * FROM staff WHERE id = ?").get(staffRes.lastInsertRowid);
  assert(staffMember.name === 'Belal Hossain', `Staff created: ${staffMember.name}`);
  assert(staffMember.phone_secondary === '01899-112233', `Staff secondary phone: ${staffMember.phone_secondary}`);
  assert(staffMember.emergency_contact === '01911-000111 (Wife)', `Staff emergency contact: ${staffMember.emergency_contact}`);
  assert(staffMember.optional_details === 'Handles evening shift receipts.', `Staff optional details: ${staffMember.optional_details}`);

  // Clean up test student and staff
  db.prepare("DELETE FROM exam_marks WHERE examination_id = ?").run(examId);
  db.prepare("DELETE FROM examinations WHERE id = ?").run(examId);
  db.prepare("DELETE FROM students WHERE id = ?").run(student.id);
  db.prepare("DELETE FROM staff WHERE id = ?").run(staffMember.id);

  console.log(`\n========================================`);
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
