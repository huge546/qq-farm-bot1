<script setup lang="ts">
import { NButton, NCard, NDataTable, NModal, NTag, useDialog } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { computed, h, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useToastStore } from '@/stores/toast'

const toastStore = useToastStore()
const dialog = useDialog()

const users = ref<any[]>([])
const stats = ref<any>({ total: 0, active: 0, expired: 0 })
const search = ref('')
const statusFilter = ref('all')
const loading = ref(false)

const adjustVisible = ref(false)
const adjustKind = ref<'duration' | 'quota'>('duration')
const adjustTarget = ref<any>(null)
const adjustValue = ref<number | string>(30)
const adjusting = ref(false)

async function loadUsers() {
  loading.value = true
  try {
    const res = await api.get('/api/admin/users')
    if (res.data.ok) {
      users.value = res.data.data.users
      stats.value = res.data.data.stats
    }
  }
  catch (e: any) {
    toastStore.error(e.response?.data?.error || e.message || '读取用户列表失败')
  }
  finally {
    loading.value = false
  }
}

const filteredUsers = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return users.value.filter((user) => {
    if (keyword && !String(user.username || '').toLowerCase().includes(keyword)) return false
    if (statusFilter.value === 'expired' && !user.expired) return false
    if (statusFilter.value === 'active' && user.expired) return false
    return true
  })
})

const expiredUsers = computed(() => users.value.filter(user => user.expired))

function fmtTime(t?: number | null): string {
  if (!t) return '-'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function durationText(row: any): string {
  if (row.expired) return '已到期'
  if (row.durationActive) return fmtTime(row.durationEnd)
  return '未开通'
}

function openAdjust(row: any, kind: 'duration' | 'quota') {
  adjustTarget.value = row
  adjustKind.value = kind
  adjustValue.value = kind === 'duration' ? 30 : 1
  adjustVisible.value = true
}

const adjustTitle = computed(() => {
  const name = adjustTarget.value?.username || ''
  return adjustKind.value === 'duration' ? `为 ${name} 增加时长` : `为 ${name} 增加账号额度`
})

async function submitAdjust() {
  const target = adjustTarget.value
  if (!target) return
  const value = Number.parseInt(String(adjustValue.value), 10)
  if (!Number.isFinite(value) || value <= 0) {
    toastStore.warning(adjustKind.value === 'duration' ? '请输入大于 0 的天数' : '请输入大于 0 的额度数量')
    return
  }
  adjusting.value = true
  try {
    const url = adjustKind.value === 'duration'
      ? `/api/admin/users/${encodeURIComponent(target.id)}/duration`
      : `/api/admin/users/${encodeURIComponent(target.id)}/quota`
    const payload = adjustKind.value === 'duration' ? { days: value } : { accounts: value }
    const res = await api.post(url, payload)
    if (res.data.ok) {
      toastStore.success(adjustKind.value === 'duration' ? `已增加 ${value} 天时长` : `已增加 ${value} 个账号额度`)
      adjustVisible.value = false
      await loadUsers()
    }
    else {
      toastStore.error(res.data.error || '操作失败')
    }
  }
  catch (e: any) {
    toastStore.error(e.response?.data?.error || e.message || '操作失败')
  }
  finally {
    adjusting.value = false
  }
}

function confirmDelete(row: any) {
  dialog.warning({
    title: '删除注册用户',
    content: `确定删除用户「${row.username}」吗？该用户绑定的 ${row.usedAccounts} 个账号也会一并删除，且无法恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await doDelete(row.id, row.username)
    },
  })
}

function confirmCleanExpired() {
  const targets = expiredUsers.value
  if (!targets.length) {
    toastStore.warning('当前没有已到期的用户')
    return
  }
  dialog.warning({
    title: '清理已到期用户',
    content: `将删除 ${targets.length} 个已到期的注册用户，其名下账号会一并删除，且无法恢复。`,
    positiveText: '全部删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      let failed = 0
      for (const user of targets) {
        try {
          const res = await api.delete(`/api/admin/users/${encodeURIComponent(user.id)}`)
          if (!res.data.ok) failed++
        }
        catch {
          failed++
        }
      }
      await loadUsers()
      if (failed) toastStore.warning(`已完成，${failed} 个用户删除失败`)
      else toastStore.success(`已删除 ${targets.length} 个已到期用户`)
    },
  })
}

async function doDelete(userId: string, username: string) {
  try {
    const res = await api.delete(`/api/admin/users/${encodeURIComponent(userId)}`)
    if (res.data.ok) {
      const removed = res.data.data?.removedAccounts?.length || 0
      toastStore.success(`已删除用户 ${username}${removed ? `，同时清理了 ${removed} 个账号` : ''}`)
      await loadUsers()
    }
    else {
      toastStore.error(res.data.error || '删除失败')
    }
  }
  catch (e: any) {
    toastStore.error(e.response?.data?.error || e.message || '删除失败')
  }
}

const columns = computed<DataTableColumns<any>>(() => [
  { title: '用户名', key: 'username', width: 160, render: (row: any) => h('span', { class: 'font-medium' }, row.username) },
  {
    title: '状态',
    key: 'status',
    width: 92,
    render: (row: any) => h(
      NTag,
      { type: row.expired ? 'error' : 'success', size: 'small' },
      { default: () => row.expired ? '已到期' : '正常' },
    ),
  },
  {
    title: '会员有效期',
    key: 'durationEnd',
    width: 160,
    render: (row: any) => h(
      'span',
      { class: row.expired ? 'text-xs text-red-500' : 'text-xs' },
      row.expired ? `已到期（${fmtTime(row.durationEnd)}）` : durationText(row),
    ),
  },
  {
    title: '账号配额',
    key: 'quota',
    width: 190,
    render: (row: any) => h('div', { class: 'flex flex-col gap-0.5' }, [
      h('span', { class: 'text-xs font-medium' }, `已用 ${row.usedAccounts} / 上限 ${row.maxAccounts}`),
      h('span', { class: 'text-xs text-coolgray-9' }, `基础 ${row.baseQuota} · 卡密 ${row.cardBonus} · 管理员 ${row.bonusAccounts}`),
    ]),
  },
  { title: '注册时间', key: 'createdAt', width: 132, render: (row: any) => h('span', { class: 'text-xs' }, fmtTime(row.createdAt)) },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    render: (row: any) => h('div', { class: 'flex items-center gap-1' }, [
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => openAdjust(row, 'duration') }, { default: () => '加时长' }),
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => openAdjust(row, 'quota') }, { default: () => '加额度' }),
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => confirmDelete(row) }, { default: () => h('span', { class: 'text-red-500' }, '删除') }),
    ]),
  },
])

onMounted(loadUsers)
</script>

<template>
  <div class="flex flex-col gap-4">
    <section class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          用户管理
        </h1>
        <p class="text-sm text-coolgray-9">
          管理注册用户的会员时长、账号额度与账号清理
        </p>
      </div>
    </section>

    <div class="grid grid-cols-3 gap-3">
      <NCard size="small">
        <div class="text-xs text-coolgray-9">
          注册用户
        </div>
        <div class="mt-1 text-xl font-semibold">
          {{ stats.total }}
        </div>
      </NCard>
      <NCard size="small">
        <div class="text-xs text-coolgray-9">
          正常
        </div>
        <div class="mt-1 text-xl font-semibold text-green-6">
          {{ stats.active }}
        </div>
      </NCard>
      <NCard size="small">
        <div class="text-xs text-coolgray-9">
          已到期
        </div>
        <div class="mt-1 text-xl font-semibold text-red-6">
          {{ stats.expired }}
        </div>
      </NCard>
    </div>

    <NCard title="注册用户列表" size="small">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <BaseInput v-model="search" placeholder="搜索用户名..." clearable class="!w-52" />
        <BaseSelect
          v-model="statusFilter"
          class="!w-32"
          :options="[
            { label: '全部状态', value: 'all' },
            { label: '正常', value: 'active' },
            { label: '已到期', value: 'expired' },
          ]"
        />
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <BaseButton size="sm" variant="outline" :loading="loading" @click="loadUsers">
            刷新
          </BaseButton>
          <BaseButton size="sm" variant="secondary" @click="confirmCleanExpired">
            清理已到期{{ expiredUsers.length ? `（${expiredUsers.length}）` : '' }}
          </BaseButton>
        </div>
      </div>
      <NDataTable
        :columns="columns"
        :data="filteredUsers"
        :loading="loading"
        :pagination="{ pageSize: 20 }"
        :scroll-x="940"
        :bordered="false"
        :size="'small'"
        :row-key="(row: any) => row.id"
      />
    </NCard>

    <NModal
      v-model:show="adjustVisible"
      preset="card"
      :title="adjustTitle"
      style="width: 380px"
    >
      <div class="flex flex-col gap-2">
        <label class="text-xs text-coolgray-9">
          {{ adjustKind === 'duration' ? '增加天数' : '增加账号数量' }}
        </label>
        <BaseInput v-model="adjustValue" type="number" min="1" />
        <p class="text-xs text-coolgray-9">
          {{ adjustKind === 'duration' ? '在现有到期时间基础上顺延；已到期的用户从当前时间开始计算。' : '直接提升该用户的账号数量上限。' }}
        </p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <BaseButton size="sm" variant="outline" @click="adjustVisible = false">
            取消
          </BaseButton>
          <BaseButton size="sm" variant="primary" :loading="adjusting" @click="submitAdjust">
            确定
          </BaseButton>
        </div>
      </template>
    </NModal>
  </div>
</template>
